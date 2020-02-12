/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* eslint-disable prefer-template */
/* eslint-disable no-underscore-dangle */
/* global actions, api */

const CONTRACT_NAME = 'nftmarket';

// cannot buy or sell more than this number of NFT instances in one action
const MAX_NUM_UNITS_OPERABLE = 50;

actions.createSSC = async () => {
  // nothing to do here
};

// check that token transfers succeeded
const isTokenTransferVerified = (result, from, to, symbol, quantity, eventStr) => {
  if (result.errors === undefined
    && result.events && result.events.find(el => el.contract === 'tokens' && el.event === eventStr
    && el.data.from === from && el.data.to === to && el.data.quantity === quantity && el.data.symbol === symbol) !== undefined) {
    return true;
  }
  return false;
};

const countDecimals = value => api.BigNumber(value).dp();

// a valid Steem account is between 3 and 16 characters in length
const isValidSteemAccountLength = account => account.length >= 3 && account.length <= 16;

// helper for buy action
const makeMapKey = (account, type) => account + '-' + type;

// helper for updating open interest
const makeGroupingKey = (grouping, groupBy) => {
  let key = '';
  groupBy.forEach((name) => {
    key = key + ':' + name + ':' + grouping[name];
  });
  return key;
};

const isValidIdArray = (arr) => {
  try {
    if (!api.assert(arr && typeof arr === 'object' && Array.isArray(arr), 'invalid id list')) {
      return false;
    }

    if (!api.assert(arr.length <= MAX_NUM_UNITS_OPERABLE, `cannot act on more than ${MAX_NUM_UNITS_OPERABLE} IDs at once`)) {
      return false;
    }

    for (let i = 0; i < arr.length; i += 1) {
      const id = arr[i];
      if (!api.assert(id && typeof id === 'string' && !api.BigNumber(id).isNaN() && api.BigNumber(id).gt(0), 'invalid id list')) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

const isGroupingInOpenInterest = async (symbol, priceSymbol, grouping) => {
  const metricsTableName = symbol + 'openInterest';

  const openInterest = await api.db.findOne(
    metricsTableName,
    {
      side: 'sell',
      priceSymbol,
      grouping,
    }
  );

  if (openInterest) {
    return true;
  }
  return false;
};

const isLessThanLowestAsk = async (symbol, priceSymbol, priceDec, grouping) => {
  const sellBookTableName = symbol + 'sellBook';

  const orders = await api.db.find(
    sellBookTableName,
    {
      priceSymbol,
      grouping,
      priceDec: {
        $lte: priceDec,
      },
    },
    MAX_NUM_UNITS_OPERABLE,
    0,
    [{ index: 'grouping', descending: false }, { index: 'priceSymbol', descending: false }],
  );

  if (orders.length > 0) {
    return false;
  }

  return true;
};

actions.enableMarket = async (payload) => {
  const {
    symbol,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    // make sure NFT exists and verify ownership
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (api.assert(nft !== null, 'symbol does not exist')
      && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
      // create a new table to hold market orders for this NFT
      const marketTableName = symbol + 'sellBook';
      const metricsTableName = symbol + 'openInterest';
      const historyTableName = symbol + 'tradesHistory';
      const tableExists = await api.db.tableExists(marketTableName);
      if (api.assert(tableExists === false, 'market already enabled')) {
        await api.db.createTable(marketTableName, ['ownedBy', 'account', 'nftId', 'grouping', 'priceSymbol']);
        await api.db.createTable(metricsTableName, ['side', 'priceSymbol', 'grouping']);
        await api.db.createTable(historyTableName, ['priceSymbol', 'timestamp']);

        api.emit('enableMarket', { symbol });
      }
    }
  }
};

actions.enableBids = async (payload) => {
  const {
    symbol,
    isSignedWithActiveKey,
  } = payload;

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    // make sure NFT exists and verify ownership
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (api.assert(nft !== null, 'symbol does not exist')
      && api.assert(nft.issuer === api.sender, 'must be the issuer')) {
      // create a new table to hold buy side market orders for this NFT
      const buyTableName = symbol + 'buyBook';
      const sellTableName = symbol + 'sellBook';
      const sellTableExists = await api.db.tableExists(sellTableName);
      const buyTableExists = await api.db.tableExists(buyTableName);
      if (api.assert(sellTableExists === true, 'market must be enabled first')
        && api.assert(buyTableExists === false, 'bids already enabled')) {
        await api.db.createTable(buyTableName, ['ownedBy', 'account', 'grouping', 'priceSymbol']);

        api.emit('enableBids', { symbol });
      }
    }
  }
};

const updateOpenInterest = async (side, symbol, priceSymbol, groups, groupBy) => {
  const metricsTableName = symbol + 'openInterest';

  // collect all the groupings to fetch
  const groupKeys = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const info of Object.values(groups)) {
    groupKeys.push(info.grouping);
  }

  if (groupKeys.length <= 0) {
    return;
  }

  const openInterest = await api.db.find(
    metricsTableName,
    {
      side,
      priceSymbol,
      grouping: {
        $in: groupKeys,
      },
    },
    MAX_NUM_UNITS_OPERABLE,
    0,
    [{ index: 'side', descending: false }, { index: 'priceSymbol', descending: false }, { index: 'grouping', descending: false }],
  );

  // update existing records...
  for (let i = 0; i < openInterest.length; i += 1) {
    const metric = openInterest[i];
    const key = makeGroupingKey(metric.grouping, groupBy);
    if (key in groups) {
      // eslint-disable-next-line no-param-reassign
      groups[key].isInCollection = true;
      metric.count += groups[key].count;
      if (metric.count < 0) {
        metric.count = 0; // shouldn't happen, but need to safeguard
      }

      await api.db.update(metricsTableName, metric);
    }
  }

  // ...and add new ones
  // eslint-disable-next-line no-restricted-syntax
  for (const info of Object.values(groups)) {
    if (!info.isInCollection) {
      const finalCount = info.count > 0 ? info.count : 0;
      const newMetric = {
        side,
        priceSymbol,
        grouping: info.grouping,
        count: finalCount,
      };

      await api.db.insert(metricsTableName, newMetric);
    }
  }
};

const updateTradesHistory = async (type, account, ownedBy, counterparties, symbol, priceSymbol, price, marketAccount, fee, volume) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const timestampMinus24hrs = blockDate.setDate(blockDate.getDate() - 1) / 1000;
  const historyTableName = symbol + 'tradesHistory';

  // clean history
  let tradesToDelete = await api.db.find(
    historyTableName,
    {
      priceSymbol,
      timestamp: {
        $lt: timestampMinus24hrs,
      },
    },
  );
  let nbTradesToDelete = tradesToDelete.length;

  while (nbTradesToDelete > 0) {
    for (let index = 0; index < nbTradesToDelete; index += 1) {
      const trade = tradesToDelete[index];
      await api.db.remove(historyTableName, trade);
    }
    tradesToDelete = await api.db.find(
      historyTableName,
      {
        priceSymbol,
        timestamp: {
          $lt: timestampMinus24hrs,
        },
      },
    );
    nbTradesToDelete = tradesToDelete.length;
  }
  // add order to the history
  const newTrade = {};
  newTrade.type = type;
  newTrade.account = account;
  newTrade.ownedBy = ownedBy;
  newTrade.counterparties = counterparties;
  newTrade.priceSymbol = priceSymbol;
  newTrade.price = price;
  newTrade.marketAccount = marketAccount;
  newTrade.fee = fee;
  newTrade.timestamp = timestampSec;
  newTrade.volume = volume;
  await api.db.insert(historyTableName, newTrade);
};

actions.changePrice = async (payload) => {
  const {
    symbol,
    nfts,
    price,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && isValidIdArray(nfts)
    && api.assert(price && typeof price === 'string' && !api.BigNumber(price).isNaN(), 'invalid params')
    && api.assert(tableExists, 'market not enabled for symbol')) {
    // look up order info
    const orders = await api.db.find(
      marketTableName,
      {
        nftId: {
          $in: nfts,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: 'nftId', descending: false }],
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      // and all orders have the same price symbol
      let priceSymbol = '';
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (priceSymbol === '') {
          ({ priceSymbol } = order);
        }
        if (!api.assert(order.account === api.sender
          && order.ownedBy === 'u', 'all orders must be your own')
          || !api.assert(priceSymbol === order.priceSymbol, 'all orders must have the same price symbol')) {
          return;
        }
      }
      // get the price token params
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
      if (api.assert(token
        && api.BigNumber(price).gt(0)
        && countDecimals(price) <= token.precision, 'invalid price')) {
        const finalPrice = api.BigNumber(price).toFixed(token.precision);
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          const oldPrice = order.price;
          order.price = finalPrice;
          order.priceDec = { $numberDecimal: finalPrice };

          await api.db.update(marketTableName, order);

          api.emit('changePrice', {
            symbol,
            nftId: order.nftId,
            oldPrice,
            newPrice: order.price,
            priceSymbol: order.priceSymbol,
            orderId: order._id,
          });
        }
      }
    }
  }
};

actions.cancel = async (payload) => {
  const {
    symbol,
    nfts,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && isValidIdArray(nfts)
    && api.assert(tableExists, 'market not enabled for symbol')) {
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (!api.assert(nft && nft.groupBy && nft.groupBy.length > 0, 'market grouping not set')) {
      return;
    }

    // look up order info
    const orders = await api.db.find(
      marketTableName,
      {
        nftId: {
          $in: nfts,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: 'nftId', descending: false }],
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      const ids = [];
      const idMap = {};
      let priceSymbol = '';
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (priceSymbol === '') {
          ({ priceSymbol } = order);
        }
        if (!api.assert(order.account === api.sender && order.ownedBy === 'u', 'all orders must be your own')
          || !api.assert(priceSymbol === order.priceSymbol, 'all orders must have the same price symbol')) {
          return;
        }
        ids.push(order.nftId);
        idMap[order.nftId] = order;
      }

      // move the locked NFTs back to their owner
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract('nft', 'transfer', {
        fromType: 'contract',
        to: api.sender,
        toType: 'user',
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible (but unlikely) that some transfers could have failed
      // due to validation errors & whatnot, so we need to loop over the
      // transfer results and only cancel orders for the transfers that succeeded
      if (res.events) {
        const groupingMap = {};
        for (let j = 0; j < res.events.length; j += 1) {
          const ev = res.events[j];
          if (ev.contract && ev.event && ev.data
            && ev.contract === 'nft'
            && ev.event === 'transfer'
            && ev.data.from === CONTRACT_NAME
            && ev.data.fromType === 'c'
            && ev.data.to === api.sender
            && ev.data.toType === 'u'
            && ev.data.symbol === symbol) {
            // transfer is verified, now we can cancel the order
            const instanceId = ev.data.id;
            if (instanceId in idMap) {
              const order = idMap[instanceId];

              await api.db.remove(marketTableName, order);

              api.emit('cancelOrder', {
                account: order.account,
                ownedBy: order.ownedBy,
                symbol,
                nftId: order.nftId,
                timestamp: order.timestamp,
                price: order.price,
                priceSymbol: order.priceSymbol,
                fee: order.fee,
                orderId: order._id,
              });

              const key = makeGroupingKey(order.grouping, nft.groupBy);
              const groupInfo = key in groupingMap
                ? groupingMap[key]
                : {
                  grouping: order.grouping,
                  isInCollection: false,
                  count: 0,
                };
              groupInfo.count -= 1;
              groupingMap[key] = groupInfo;
            }
          }
        }

        // update open interest metrics
        await updateOpenInterest('sell', symbol, priceSymbol, groupingMap, nft.groupBy);
      }
    }
  }
};

actions.buy = async (payload) => {
  const {
    symbol,
    nfts,
    marketAccount,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string'
    && marketAccount && typeof marketAccount === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && isValidIdArray(nfts)
    && api.assert(tableExists, 'market not enabled for symbol')) {
    const finalMarketAccount = marketAccount.trim().toLowerCase();
    if (api.assert(isValidSteemAccountLength(finalMarketAccount), 'invalid market account')) {
      const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
      if (!api.assert(nft && nft.groupBy && nft.groupBy.length > 0, 'market grouping not set')) {
        return;
      }

      // look up order info
      const orders = await api.db.find(
        marketTableName,
        {
          nftId: {
            $in: nfts,
          },
        },
        MAX_NUM_UNITS_OPERABLE,
        0,
        [{ index: 'nftId', descending: false }],
      );

      if (orders.length > 0) {
        // do a couple more sanity checks
        let priceSymbol = '';
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          if (priceSymbol === '') {
            ({ priceSymbol } = order);
          }
          if (!api.assert(!(order.ownedBy === 'u' && order.account === api.sender), 'cannot fill your own orders')
            || !api.assert(priceSymbol === order.priceSymbol, 'all orders must have the same price symbol')) {
            return;
          }
        }
        // get the price token params
        const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
        if (!token) {
          return;
        }

        // create order maps
        let feeTotal = api.BigNumber(0);
        let paymentTotal = api.BigNumber(0);
        let soldNfts = [];
        const sellers = [];
        const sellerMap = {};
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          const finalPrice = api.BigNumber(order.price);
          const feePercent = order.fee / 10000;
          let finalFee = finalPrice.multipliedBy(feePercent).decimalPlaces(token.precision);
          if (finalFee.gt(finalPrice)) {
            finalFee = finalPrice; // unlikely but need to be sure
          }
          let finalPayment = finalPrice.minus(finalFee).decimalPlaces(token.precision);
          if (finalPayment.lt(0)) {
            finalPayment = api.BigNumber(0); // unlikely but need to be sure
          }
          paymentTotal = paymentTotal.plus(finalPayment);
          feeTotal = feeTotal.plus(finalFee);

          const key = makeMapKey(order.account, order.ownedBy);
          const sellerInfo = key in sellerMap
            ? sellerMap[key]
            : {
              account: order.account,
              ownedBy: order.ownedBy,
              nftIds: [],
              paymentTotal: api.BigNumber(0),
            };

          sellerInfo.paymentTotal = sellerInfo.paymentTotal.plus(finalPayment);
          sellerInfo.nftIds.push(order.nftId);
          sellerMap[key] = sellerInfo;
        }

        // verify buyer has enough funds for payment
        const requiredBalance = paymentTotal.plus(feeTotal).toFixed(token.precision);
        const buyerBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: priceSymbol });
        if (!api.assert(buyerBalance
          && api.BigNumber(buyerBalance.balance).gte(requiredBalance), 'you must have enough tokens for payment')) {
          return;
        }
        paymentTotal = paymentTotal.toFixed(token.precision);

        // send fees to market account
        if (feeTotal.gt(0)) {
          feeTotal = feeTotal.toFixed(token.precision);
          const res = await api.executeSmartContract('tokens', 'transfer', {
            to: finalMarketAccount, symbol: priceSymbol, quantity: feeTotal, isSignedWithActiveKey,
          });
          if (!api.assert(isTokenTransferVerified(res, api.sender, finalMarketAccount, priceSymbol, feeTotal, 'transfer'), 'unable to transfer market fees')) {
            return;
          }
        }

        // send payments to sellers
        // eslint-disable-next-line no-restricted-syntax
        for (const info of Object.values(sellerMap)) {
          if (info.paymentTotal.gt(0)) {
            const contractAction = info.ownedBy === 'u' ? 'transfer' : 'transferToContract';
            info.paymentTotal = info.paymentTotal.toFixed(token.precision);
            const res = await api.executeSmartContract('tokens', contractAction, {
              to: info.account, symbol: priceSymbol, quantity: info.paymentTotal, isSignedWithActiveKey,
            });
            if (api.assert(isTokenTransferVerified(res, api.sender, info.account, priceSymbol, info.paymentTotal, contractAction), `unable to transfer payment to ${info.account}`)) {
              soldNfts = soldNfts.concat(info.nftIds);
              sellers.push(info);
            }
          } else {
            soldNfts = soldNfts.concat(info.nftIds);
            sellers.push(info);
          }
        }

        // transfer sold NFT instances to new owner
        const nftArray = [];
        const wrappedNfts = {
          symbol,
          ids: soldNfts,
        };
        nftArray.push(wrappedNfts);
        await api.executeSmartContract('nft', 'transfer', {
          fromType: 'contract',
          to: api.sender,
          toType: 'user',
          nfts: nftArray,
          isSignedWithActiveKey,
        });

        // delete sold market orders
        const groupingMap = {};
        const soldSet = new Set(soldNfts);
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          if (soldSet.has(order.nftId)) {
            await api.db.remove(marketTableName, order);

            const key = makeGroupingKey(order.grouping, nft.groupBy);
            const groupInfo = key in groupingMap
              ? groupingMap[key]
              : {
                grouping: order.grouping,
                isInCollection: false,
                count: 0,
              };
            groupInfo.count -= 1;
            groupingMap[key] = groupInfo;
          }
        }

        // add the trade to the history
        await updateTradesHistory('buy', api.sender, 'u', sellers, symbol, priceSymbol, requiredBalance, finalMarketAccount, feeTotal, soldNfts.length);

        api.emit('hitSellOrder', {
          symbol,
          priceSymbol,
          account: api.sender,
          ownedBy: 'u',
          sellers,
          paymentTotal,
          feeTotal,
        });

        // update open interest metrics
        await updateOpenInterest('sell', symbol, priceSymbol, groupingMap, nft.groupBy);
      }
    }
  }
};

actions.cancelBid = async (payload) => {
  const {
    symbol,
    orderIds,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'buyBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && isValidIdArray(orderIds)
    && api.assert(tableExists, 'bids not enabled for symbol')) {
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (!api.assert(nft && nft.groupBy && nft.groupBy.length > 0, 'market grouping not set')) {
      return;
    }

    // convert input order IDs to numbers
    const finalOrderIds = [];
    orderIds.forEach((id) => {
      finalOrderIds.push(api.BigNumber(id).toNumber());
    });

    // look up order info
    let orders = await api.db.find(
      marketTableName,
      {
        _id: {
          $in: finalOrderIds,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: '_id', descending: false }],
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      let priceSymbol = '';
      let nbTokensToUnlock = api.BigNumber(0);
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (priceSymbol === '') {
          ({ priceSymbol } = order);
        }
        if (!api.assert(order.account === api.sender && order.ownedBy === 'u', 'all orders must be your own')
          || !api.assert(priceSymbol === order.priceSymbol, 'all orders must have the same price symbol')) {
          return;
        }
        const nbTokensForOrder = api.BigNumber(order.price).multipliedBy(order.quantity);
        nbTokensToUnlock = nbTokensToUnlock.plus(nbTokensForOrder);
      }

      // get the price token params
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
      if (!api.assert(token)) {
        return;
      }

      nbTokensToUnlock = nbTokensToUnlock.toFixed(token.precision);

      // move the locked tokens from the market back to their owner
      const res = await api.transferTokens(api.sender, priceSymbol, nbTokensToUnlock, 'user');
      if (!api.assert(isTokenTransferVerified(res, CONTRACT_NAME, api.sender, priceSymbol, nbTokensToUnlock, 'transferFromContract'), 'unable to return locked tokens for bids')) {
        return;
      }

      // now we can cancel the bids one by one
      let nbPendingCancelations = orders.length;
      let firstTry = true;
      const groupingMap = {};
      while (nbPendingCancelations > 0) {
        for (let index = 0; index < nbPendingCancelations; index += 1) {
          const order = orders[index];

          await api.db.remove(marketTableName, order);

          if (firstTry) {
            api.emit('cancelBid', {
              account: order.account,
              ownedBy: order.ownedBy,
              symbol,
              grouping: order.grouping,
              quantity: order.quantity,
              timestamp: order.timestamp,
              price: order.price,
              priceSymbol: order.priceSymbol,
              marketAccount: order.marketAccount,
              orderId: order._id,
            });

            const key = makeGroupingKey(order.grouping, nft.groupBy);
            const groupInfo = key in groupingMap
              ? groupingMap[key]
              : {
                grouping: order.grouping,
                isInCollection: false,
                count: 0,
              };
            groupInfo.count -= order.quantity;
            groupingMap[key] = groupInfo;
          }
        }
        firstTry = false;

        // sanity check to make sure bids were actually removed
        orders = await api.db.find(
          marketTableName,
          {
            _id: {
              $in: finalOrderIds,
            },
          },
          MAX_NUM_UNITS_OPERABLE,
          0,
          [{ index: '_id', descending: false }],
        );

        nbPendingCancelations = orders.length;
      }

      // update open interest metrics
      await updateOpenInterest('buy', symbol, priceSymbol, groupingMap, nft.groupBy);
    }
  }
};

actions.bid = async (payload) => {
  const {
    symbol,
    grouping,
    quantity,
    price,
    priceSymbol,
    marketAccount,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string'
    && marketAccount && typeof marketAccount === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'buyBook';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(grouping && typeof grouping === 'object'
    && priceSymbol && typeof priceSymbol === 'string'
    && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
    && quantity && typeof quantity === 'number' && quantity > 0 && Number.isInteger(quantity), 'invalid params')
    && api.assert(tableExists, 'bids not enabled for symbol')) {
    const finalMarketAccount = marketAccount.trim().toLowerCase();
    if (api.assert(isValidSteemAccountLength(finalMarketAccount), 'invalid market account')) {
      const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
      if (!api.assert(nft && nft.groupBy && nft.groupBy.length > 0, 'market grouping not set')) {
        return;
      }
      const isValidGrouping = await isGroupingInOpenInterest(symbol, priceSymbol, grouping);
      if (!api.assert(isValidGrouping, 'grouping must be in open interest')) {
        return;
      }

      // get the price token params
      const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
      if (api.assert(token
        && api.BigNumber(price).gt(0)
        && countDecimals(price) <= token.precision, 'invalid price')) {
        // verify this bid does not cross the lowest ask
        const finalPrice = api.BigNumber(price).toFixed(token.precision);
        const priceDec = { $numberDecimal: finalPrice };
        const isValidBid = await isLessThanLowestAsk(symbol, priceSymbol, priceDec, grouping);
        if (!api.assert(isValidBid, 'bid price must be less than the lowest ask')) {
          return;
        }

        // verify bidder has enough funds for the purchase
        const nbTokensToLock = api.BigNumber(price)
          .multipliedBy(quantity)
          .toFixed(token.precision);
        const priceTokenBalance = await api.db.findOneInTable('tokens', 'balances', { account: api.sender, symbol: priceSymbol });
        const isBalanceSufficient = priceTokenBalance && api.BigNumber(priceTokenBalance.balance).gte(nbTokensToLock);
        if (!api.assert(isBalanceSufficient, 'insufficient token balance to pay for your bid')) {
          return;
        }

        // lock the funds for purchasing by moving them to this contract for safekeeping
        const res = await api.executeSmartContract('tokens', 'transferToContract', {
          to: CONTRACT_NAME, symbol: priceSymbol, quantity: nbTokensToLock, isSignedWithActiveKey,
        });
        if (!api.assert(isTokenTransferVerified(res, api.sender, CONTRACT_NAME, priceSymbol, nbTokensToLock, 'transferToContract'), 'unable to lock tokens for payment')) {
          return;
        }

        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const timestamp = blockDate.getTime();

        // if an order with this price already exists, add to the existing quantity
        const currentOrder = await api.db.findOne(
          marketTableName,
          {
            account: api.sender,
            ownedBy: 'u',
            grouping,
            price: finalPrice,
            priceSymbol,
          }
        );

        if (currentOrder) {
          // update existing order
          const oldQuantity = currentOrder.quantity;
          const oldTimestamp = currentOrder.timestamp;
          currentOrder.quantity += quantity;
          currentOrder.timestamp = timestamp;

          await api.db.update(marketTableName, currentOrder);

          api.emit('editBid', {
            symbol,
            grouping,
            oldQuantity,
            newQuantity: currentOrder.quantity,
            oldTimestamp,
            newTimestamp: currentOrder.timestamp,
            priceSymbol: currentOrder.priceSymbol,
            orderId: currentOrder._id,
          });
        } else {
          // create a new order
          const order = {
            account: api.sender,
            ownedBy: 'u',
            grouping,
            quantity,
            timestamp,
            price: finalPrice,
            priceDec,
            priceSymbol,
            marketAccount: finalMarketAccount,
          };

          const result = await api.db.insert(marketTableName, order);

          api.emit('buyOrder', {
            account: order.account,
            ownedBy: order.ownedBy,
            symbol,
            grouping,
            quantity,
            timestamp,
            price: order.price,
            priceSymbol: order.priceSymbol,
            marketAccount: order.marketAccount,
            orderId: result._id,
          });
        }

        // update open interest metrics
        const groupingMap = {};
        const key = makeGroupingKey(grouping, nft.groupBy);
        const groupInfo = {
          grouping,
          isInCollection: false,
          count: quantity,
        };
        groupingMap[key] = groupInfo;
        await updateOpenInterest('buy', symbol, priceSymbol, groupingMap, nft.groupBy);
      }
    }
  }
};

actions.sell = async (payload) => {
  const {
    symbol,
    nfts,
    price,
    priceSymbol,
    fee,
    isSignedWithActiveKey,
  } = payload;

  if (!api.assert(symbol && typeof symbol === 'string', 'invalid params')) {
    return;
  }

  const marketTableName = symbol + 'sellBook';
  const instanceTableName = symbol + 'instances';
  const tableExists = await api.db.tableExists(marketTableName);

  if (api.assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
    && api.assert(nfts && typeof nfts === 'object' && Array.isArray(nfts)
    && priceSymbol && typeof priceSymbol === 'string'
    && price && typeof price === 'string' && !api.BigNumber(price).isNaN()
    && fee && typeof fee === 'number' && fee >= 0 && fee <= 10000 && Number.isInteger(fee), 'invalid params')
    && api.assert(nfts.length <= MAX_NUM_UNITS_OPERABLE, `cannot sell more than ${MAX_NUM_UNITS_OPERABLE} NFT instances at once`)
    && api.assert(tableExists, 'market not enabled for symbol')) {
    const nft = await api.db.findOneInTable('nft', 'nfts', { symbol });
    if (!api.assert(nft && nft.groupBy && nft.groupBy.length > 0, 'market grouping not set')) {
      return;
    }

    // get the price token params
    const token = await api.db.findOneInTable('tokens', 'tokens', { symbol: priceSymbol });
    if (api.assert(token
      && api.BigNumber(price).gt(0)
      && countDecimals(price) <= token.precision, 'invalid price')) {
      // lock the NFTs to sell by moving them to this contract for safekeeping
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids: nfts,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract('nft', 'transfer', {
        fromType: 'user',
        to: CONTRACT_NAME,
        toType: 'contract',
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible that some transfers could have failed due to validation
      // errors & whatnot, so we need to loop over the transfer results and
      // only create market orders for the transfers that succeeded
      if (res.events) {
        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const timestamp = blockDate.getTime();
        const finalPrice = api.BigNumber(price).toFixed(token.precision);
        const nftIntegerIdList = [];
        const orderDataMap = {};

        for (let i = 0; i < res.events.length; i += 1) {
          const ev = res.events[i];
          if (ev.contract && ev.event && ev.data
            && ev.contract === 'nft'
            && ev.event === 'transfer'
            && ev.data.from === api.sender
            && ev.data.fromType === 'u'
            && ev.data.to === CONTRACT_NAME
            && ev.data.toType === 'c'
            && ev.data.symbol === symbol) {
            // transfer is verified, now we can add a market order
            const instanceId = ev.data.id;

            const orderData = {
              nftId: instanceId,
              grouping: {},
              groupingKey: '',
            };
            const integerId = api.BigNumber(instanceId).toNumber();
            nftIntegerIdList.push(integerId);
            orderDataMap[integerId] = orderData;
          }
        }

        // query NFT instances to construct the grouping
        const instances = await api.db.findInTable(
          'nft',
          instanceTableName,
          {
            _id: {
              $in: nftIntegerIdList,
            },
          },
          MAX_NUM_UNITS_OPERABLE,
          0,
          [{ index: '_id', descending: false }],
        );

        for (let j = 0; j < instances.length; j += 1) {
          const instance = instances[j];
          const grouping = {};
          let groupingKey = '';
          nft.groupBy.forEach((name) => {
            if (instance.properties[name] !== undefined && instance.properties[name] !== null) {
              grouping[name] = instance.properties[name].toString();
            } else {
              grouping[name] = '';
            }
            groupingKey = groupingKey + ':' + name + ':' + grouping[name];
          });
          orderDataMap[instance._id].grouping = grouping;
          orderDataMap[instance._id].groupingKey = groupingKey;
        }

        // create the orders
        const groupingMap = {};
        for (let k = 0; k < nftIntegerIdList.length; k += 1) {
          const intId = nftIntegerIdList[k];
          const orderInfo = orderDataMap[intId];
          const order = {
            account: api.sender,
            ownedBy: 'u',
            nftId: orderInfo.nftId,
            grouping: orderInfo.grouping,
            timestamp,
            price: finalPrice,
            priceDec: { $numberDecimal: finalPrice },
            priceSymbol,
            fee,
          };

          const result = await api.db.insert(marketTableName, order);

          api.emit('sellOrder', {
            account: order.account,
            ownedBy: order.ownedBy,
            symbol,
            nftId: order.nftId,
            timestamp,
            price: order.price,
            priceSymbol: order.priceSymbol,
            fee,
            orderId: result._id,
          });

          const groupInfo = orderInfo.groupingKey in groupingMap
            ? groupingMap[orderInfo.groupingKey]
            : {
              grouping: orderInfo.grouping,
              isInCollection: false,
              count: 0,
            };
          groupInfo.count += 1;
          groupingMap[orderInfo.groupingKey] = groupInfo;
        }

        // update open interest metrics
        await updateOpenInterest('sell', symbol, priceSymbol, groupingMap, nft.groupBy);
      }
    }
  }
};
