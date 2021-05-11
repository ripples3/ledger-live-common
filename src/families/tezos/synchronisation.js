// @flow
import invariant from "invariant";
import { BigNumber } from "bignumber.js";
import union from "lodash/union";
import throttle from "lodash/throttle";
import flatMap from "lodash/flatMap";
import { log } from "@ledgerhq/logs";
import { mergeOps } from "../../bridge/jsHelpers";
import type { GetAccountShape } from "../../bridge/jsHelpers";
import {
  encodeTokenAccountId,
  decodeTokenAccountId,
  areAllOperationsLoaded,
  inferSubOperations,
  emptyHistoryCache,
} from "../../account";
import {
  findTokenByAddress,
  listTokensForCryptoCurrency,
} from "../../currencies";
import { encodeOperationId } from "../../operation";
import type { Operation, TokenAccount, Account } from "../../types";
import api from "./api/tzkt";
import type { APIOperation } from "./api/tzkt";

export const getAccountShape: GetAccountShape = async (infoInput) => {
  let { currency, address, initialAccount } = infoInput;

  const initialStableOperations = initialAccount
    ? initialAccount.operations // TODO stableOperations like eth, we need to full reset if id changed from libcore
    : [];

  // fetch transactions, incrementally if possible
  const mostRecentStableOperation = initialStableOperations[0];

  const apiAccountPromise = api.getAccountByAddress(address);
  const blocksCountPromise = api.getBlockCount();

  const [apiAccount, blockHeight] = await Promise.all([
    apiAccountPromise,
    blocksCountPromise,
  ]);

  if (apiAccount.type === "empty") {
    return {
      blockHeight,
      lastSyncDate: new Date(),
    };
  }
  invariant(
    apiAccount.type === "user",
    "unsupported account of type ",
    apiAccount.type
  );

  // TODO paginate with lastId

  const apiOperations = await fetchAllTransactions(address);

  const { revealed } = apiAccount;

  const tezosResources = {
    revealed,
  };

  const balance = BigNumber(apiAccount.balance);
  const subAccounts = [];

  const newOps = apiOperations.map(txToOp(infoInput)).filter(Boolean);

  const operations = mergeOps(initialStableOperations, newOps);

  const accountShape: $Shape<Account> = {
    operations,
    balance,
    subAccounts,
    spendableBalance: balance,
    blockHeight,
    lastSyncDate: new Date(),
    tezosResources,
  };

  return accountShape;
};

const txToOp = ({ address, id: accountId }) => (
  tx: APIOperation
): ?Operation => {
  let type;
  let maybeValue;
  let senders = [];
  let recipients = [];
  const hasFailed = tx.status ? tx.status !== "applied" : false;

  switch (tx.type) {
    case "transaction": {
      const initiator = tx.initiator?.address;
      const from = tx.sender?.address;
      const to = tx.target?.address;
      if (from !== address && to !== address && initiator !== address) {
        // failsafe for a case that shouldn't happen.
        console.warn("found tx is unrelated to account! " + tx.hash);
        return;
      }
      senders = [from || initiator || ""];
      recipients = [to || ""];
      if (
        (from === address && to === address) || // self tx
        (from !== address && to !== address) // initiator but not in from/to
      ) {
        // we just pay fees in that case
        type = "FEES";
      } else {
        type = to === address ? "IN" : "OUT";
        if (!hasFailed) {
          maybeValue = BigNumber(tx.amount || 0);
          if (maybeValue.eq(0)) {
            type = "FEES";
          }
        }
      }
      break;
    }
    case "delegation":
      type = tx.newDelegate ? "DELEGATE" : "UNDELEGATE";
      senders = [address];
      // convention was to use recipient for the new delegation address or "" if undelegation
      recipients = [tx.newDelegate ? tx.newDelegate.address : ""];
      break;
    case "reveal":
      type = "REVEAL";
      senders = [address];
      recipients = [address];
      break;
    case "migration":
      type = tx.balanceChange < 0 ? "OUT" : "IN";
      maybeValue = BigNumber(Math.abs(tx.balanceChange || 0));
      senders = [address];
      recipients = [address];
      break;
    case "origination":
      type = "CREATE";
      maybeValue = BigNumber(tx.contractBalance || 0);
      senders = [address];
      recipients = [tx.originatedContract.address];
      break;
    case "activation":
      type = "IN";
      senders = [address];
      recipients = [address];
      maybeValue = BigNumber(tx.balance || 0);
      break;
    // TODO more type of tx
    default:
      console.warn("unsupported tx:", tx);
      return;
  }

  const {
    hash,
    allocationFee,
    bakerFee,
    storageFee,
    level: blockHeight,
    block: blockHash,
    timestamp,
  } = tx;

  let value = maybeValue || BigNumber(0);
  if (type === "IN" && value.eq(0)) {
    return; // not interesting op
  }

  let fee = BigNumber(bakerFee || 0);

  if (!hasFailed) {
    fee = fee.plus(allocationFee || 0).plus(storageFee || 0);
  }

  if (type !== "IN") {
    value = value.plus(fee);
  }

  return {
    id: encodeOperationId(accountId, hash, type),
    hash,
    type,
    value,
    fee,
    senders,
    recipients,
    blockHeight,
    blockHash,
    accountId,
    date: new Date(timestamp),
    extra: {},
    hasFailed,
  };
};

const fetchAllTransactions = async (
  address: string,
  lastId?: string
): Promise<APIOperation[]> => {
  let r;
  let txs = [];
  let maxIteration = 20; // safe limit
  do {
    r = await api.getAccountOperations(address, { lastId });
    if (r.length === 0) return txs;
    txs = txs.concat(r);
    lastId = txs[txs.length - 1].id;
    if (!lastId) {
      log("tezos", "id missing!");
      return txs;
    }
  } while (--maxIteration);
  return txs;
};

// TODO share it with ETH!
// reconciliate the existing token accounts so that refs don't change if no changes is contained
function reconciliateSubAccounts(tokenAccounts, initialAccount) {
  let subAccounts;
  if (initialAccount) {
    const initialSubAccounts = initialAccount.subAccounts;
    let anySubAccountHaveChanged = false;
    const stats = [];
    if (
      initialSubAccounts &&
      tokenAccounts.length !== initialSubAccounts.length
    ) {
      stats.push("length differ");
      anySubAccountHaveChanged = true;
    }
    subAccounts = tokenAccounts.map((ta) => {
      const existing = initialSubAccounts?.find((a) => a.id === ta.id);
      if (existing) {
        let shallowEqual = true;
        if (existing !== ta) {
          for (let k in existing) {
            if (existing[k] !== ta[k]) {
              shallowEqual = false;
              stats.push(`field ${k} changed for ${ta.id}`);
              break;
            }
          }
        }
        if (shallowEqual) {
          return existing;
        } else {
          anySubAccountHaveChanged = true;
        }
      } else {
        anySubAccountHaveChanged = true;
        stats.push(`new token account ${ta.id}`);
      }
      return ta;
    });
    if (!anySubAccountHaveChanged && initialSubAccounts) {
      log(
        "ethereum",
        "incremental sync: " +
          String(initialSubAccounts.length) +
          " sub accounts have not changed"
      );
      subAccounts = initialSubAccounts;
    } else {
      log(
        "ethereum",
        "incremental sync: sub accounts changed: " + stats.join(", ")
      );
    }
  } else {
    subAccounts = tokenAccounts.map((a) => a);
  }
  return subAccounts;
}