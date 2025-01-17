// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {
  SubqlTerraEventFilter,
  SubqlTerraMessageFilter,
  TerraBlock,
  TerraEvent,
  TerraTransaction,
  TerraMessage,
} from '@subql/types-terra';
import {
  BlockInfo,
  Msg,
  MsgExecuteContract,
  TxInfo,
  TxLog,
} from '@terra-money/terra.js';
import { strict } from 'yargs';
import { TerraClient } from '../indexer/apiterra.service';
import { TerraBlockContent } from '../indexer/types';
import { getLogger } from './logger';

const logger = getLogger('fetch');

export function filterMessageData(
  data: TerraMessage,
  filter: SubqlTerraMessageFilter,
): boolean {
  if (filter.type !== data.msg.toData()['@type']) {
    return false;
  }
  if (filter.values) {
    for (const key in filter.values) {
      if (!(key in data.msg) || filter.values[key] !== data.msg[key]) {
        return false;
      }
    }
  }

  if (
    filter.type === '/terra.wasm.v1beta1.MsgExecuteContract' &&
    filter.contractCall
  ) {
    const execute_msg = (data.msg as MsgExecuteContract).execute_msg;
    if (
      typeof execute_msg === 'object' &&
      !(filter.contractCall in execute_msg)
    ) {
      return false;
    } else if (
      typeof execute_msg === 'string' &&
      execute_msg !== filter.contractCall
    ) {
      return false;
    }
  }
  return true;
}

export function filterMessages(
  messages: TerraMessage[],
  filterOrFilters?:
    | SubqlTerraMessageFilter
    | SubqlTerraMessageFilter[]
    | undefined,
): TerraMessage[] {
  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return messages;
  }

  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];

  const filteredMessages = messages.filter((message) => {
    for (const filter of filters) {
      if (!filterMessageData(message, filter)) {
        continue;
      }
      return true;
    }
    return false;
  });
  return filteredMessages;
}

export function filterEvents(
  events: TerraEvent[],
  filterOrFilters?: SubqlTerraEventFilter | SubqlTerraEventFilter[] | undefined,
): TerraEvent[] {
  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return events;
  }

  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];
  const filteredEvents = events.filter((event) => {
    for (const filter of filters) {
      if (filter.type !== event.event.type) {
        continue;
      }
      if (
        filter.messageFilter &&
        !filterMessageData(event.msg, filter.messageFilter)
      ) {
        continue;
      }
      return true;
    }
    return false;
  });
  return filteredEvents;
}

async function getBlockByHeight(api: TerraClient, height: number) {
  let blockInfo: BlockInfo;
  try {
    blockInfo = await api.blockInfo(height);
  } catch (e) {
    logger.error(`failed to fetch Block ${height}`);
    throw e;
  }
  return blockInfo;
}

export async function fetchTerraBlocksArray(
  api: TerraClient,
  blockArray: number[],
): Promise<BlockInfo[]> {
  return Promise.all(
    blockArray.map(async (height) => getBlockByHeight(api, height)),
  );
}

export function wrapBlock(block: BlockInfo, txs: TxInfo[]): TerraBlock {
  return {
    block: block,
    txs: txs,
  };
}

export function wrapTx(
  block: TerraBlock,
  txInfos: TxInfo[],
): TerraTransaction[] {
  return txInfos.map((txInfo, idx) => ({
    idx,
    tx: txInfo,
    block,
  }));
}

export function wrapMsg(
  block: TerraBlock,
  txs: TerraTransaction[],
): TerraMessage[] {
  const msgs: TerraMessage[] = [];
  for (const tx of txs) {
    for (let i = 0; i < tx.tx.tx.body.messages.length; i++) {
      const msg: TerraMessage = {
        idx: i,
        tx: tx,
        block: block,
        msg: tx.tx.tx.body.messages[i],
      };
      msgs.push(msg);
    }
  }
  return msgs;
}

export function wrapEvent(
  block: TerraBlock,
  txs: TerraTransaction[],
): TerraEvent[] {
  const events: TerraEvent[] = [];
  for (const tx of txs) {
    for (const log of tx.tx.logs as TxLog[]) {
      const msg: TerraMessage = {
        idx: log.msg_index,
        tx: tx,
        block: block,
        msg: tx.tx.tx.body.messages[log.msg_index],
      };
      for (let i = 0; i < log.events.length; i++) {
        const event: TerraEvent = {
          idx: i,
          msg: msg,
          tx: tx,
          block: block,
          log: log,
          event: log.events[i],
        };
        events.push(event);
      }
    }
  }

  return events;
}

export async function fetchTerraBlocksBatches(
  api: TerraClient,
  blockArray: number[],
): Promise<TerraBlockContent[]> {
  const blocks = await fetchTerraBlocksArray(api, blockArray);
  return Promise.all(
    blocks.map(async (blockInfo) => {
      const txHashes = blockInfo.block.data.txs;
      if (txHashes === null || txHashes.length === 0) {
        return <TerraBlockContent>{
          block: wrapBlock(blockInfo, []),
          transactions: [],
          messages: [],
          events: [],
        };
      }

      const txInfos = await api.getTxInfobyHashes(
        txHashes,
        blockInfo.block.header.height,
      );
      const block = wrapBlock(blockInfo, txInfos);
      const txs = wrapTx(block, txInfos);
      const msgs = wrapMsg(block, txs);
      const events = wrapEvent(block, txs);
      return <TerraBlockContent>{
        block: block,
        transactions: txs,
        messages: msgs,
        events: events,
      };
    }),
  );
}
