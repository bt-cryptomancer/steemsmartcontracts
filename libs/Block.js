const SHA256 = require('crypto-js/sha256');
const enchex = require('crypto-js/enc-hex');

const { SmartContracts } = require('./SmartContracts');
const { Transaction } = require('../libs/Transaction');

class Block {
  constructor(timestamp, refSteemBlockNumber, refSteemBlockId, prevRefSteemBlockId, transactions, previousBlockNumber, previousHash = '', previousDatabaseHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.refSteemBlockId = refSteemBlockId;
    this.prevRefSteemBlockId = prevRefSteemBlockId;
    this.previousHash = previousHash;
    this.previousDatabaseHash = previousDatabaseHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.virtualTransactions = [];
    this.hash = this.calculateHash();
    this.databaseHash = '';
    this.merkleRoot = '';
    this.round = null;
    this.roundHash = '';
    this.witness = '';
    this.signingKey = '';
    this.roundSignature = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(
      this.previousHash
      + this.previousDatabaseHash
      + this.blockNumber.toString()
      + this.refSteemBlockNumber.toString()
      + this.refSteemBlockId
      + this.prevRefSteemBlockId
      + this.timestamp
      + JSON.stringify(this.transactions) // eslint-disable-line
    )
      .toString(enchex);
  }

  // calculate the Merkle root of the block ((#TA + #TB) + (#TC + #TD) )
  calculateMerkleRoot(transactions) {
    if (transactions.length <= 0) return '';

    const tmpTransactions = transactions.slice(0, transactions.length);
    const newTransactions = [];
    const nbTransactions = tmpTransactions.length;

    for (let index = 0; index < nbTransactions; index += 2) {
      const left = tmpTransactions[index].hash;
      const right = index + 1 < nbTransactions ? tmpTransactions[index + 1].hash : left;

      const leftDbHash = tmpTransactions[index].databaseHash;
      const rightDbHash = index + 1 < nbTransactions
        ? tmpTransactions[index + 1].databaseHash
        : leftDbHash;

      newTransactions.push({
        hash: SHA256(left + right).toString(enchex),
        databaseHash: SHA256(leftDbHash + rightDbHash).toString(enchex),
      });
    }

    if (newTransactions.length === 1) {
      return {
        hash: newTransactions[0].hash,
        databaseHash: newTransactions[0].databaseHash,
      };
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  async produceBlock(database, jsVMTimeout) {
    const nbTransactions = this.transactions.length;

    let currentDatabaseHash = this.previousDatabaseHash;

    for (let i = 0; i < nbTransactions; i += 1) {
      const transaction = this.transactions[i];
      await this.processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line

      currentDatabaseHash = transaction.databaseHash;
    }

    // remove comment, comment_options and votes if not relevant
    this.transactions = this.transactions.filter(value => value.contract !== 'comments' || value.logs === '{}');

    // handle virtual transactions
    const virtualTransactions = [];

    // check the pending unstakings and undelegation
    if (this.refSteemBlockNumber >= 32713424) {
      virtualTransactions.push(new Transaction(0, '', 'null', 'tokens', 'checkPendingUnstakes', ''));
      virtualTransactions.push(new Transaction(0, '', 'null', 'tokens', 'checkPendingUndelegations', ''));
    }

    // TODO: cleanup
    // if (this.refSteemBlockNumber >= 37899120) {
    virtualTransactions.push(new Transaction(0, '', 'null', 'witnesses', 'scheduleWitnesses', ''));
    // }

    if (this.refSteemBlockNumber >= 38145385) {
      // issue new utility tokens every time the refSteemBlockNumber % 1200 equals 0
      if (this.refSteemBlockNumber % 1200 === 0) {
        virtualTransactions.push(new Transaction(0, '', 'null', 'inflation', 'issueNewTokens', '{ "isSignedWithActiveKey": true }'));
      }

      virtualTransactions.push(new Transaction(0, '', 'null', 'nft', 'checkPendingUndelegations', ''));
    }

    const nbVirtualTransactions = virtualTransactions.length;
    for (let i = 0; i < nbVirtualTransactions; i += 1) {
      const transaction = virtualTransactions[i];
      transaction.refSteemBlockNumber = this.refSteemBlockNumber;
      transaction.transactionId = `${this.refSteemBlockNumber}-${i}`;
      await this.processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash); // eslint-disable-line
      currentDatabaseHash = transaction.databaseHash;
      // if there are outputs in the virtual transaction we save the transaction into the block
      // the "unknown error" errors are removed as they are related to a non existing action
      if (transaction.logs !== '{}'
        && transaction.logs !== '{"errors":["unknown error"]}') {
        if (transaction.contract === 'witnesses'
          && transaction.action === 'scheduleWitnesses'
          && transaction.logs === '{"errors":["contract doesn\'t exist"]}') {
          // don't save logs
        } else if (transaction.contract === 'inflation'
          && transaction.action === 'issueNewTokens'
          && transaction.logs === '{"errors":["contract doesn\'t exist"]}') {
          // don't save logs
        } else if (transaction.contract === 'nft'
          && transaction.action === 'checkPendingUndelegations'
          && transaction.logs === '{"errors":["contract doesn\'t exist"]}') {
          // don't save logs
        } else {
          this.virtualTransactions.push(transaction);
        }
      }
    }

    if (this.transactions.length > 0 || this.virtualTransactions.length > 0) {
      // calculate the merkle root of the transactions' hashes and the transactions' database hashes
      const finalTransactions = this.transactions.concat(this.virtualTransactions);

      const merkleRoots = this.calculateMerkleRoot(finalTransactions);
      this.merkleRoot = merkleRoots.hash;
      this.databaseHash = merkleRoots.databaseHash;
      this.hash = this.calculateHash();
    }
  }

  async processTransaction(database, jsVMTimeout, transaction, currentDatabaseHash) {
    const {
      sender,
      contract,
      action,
      payload,
    } = transaction;

    let results = null;
    let newCurrentDatabaseHash = currentDatabaseHash;

    // init the database hash for that transactions
    database.initDatabaseHash(newCurrentDatabaseHash);

    if (sender && contract && action) {
      if (contract === 'contract' && (action === 'deploy' || action === 'update') && payload) {
        const authorizedAccountContractDeployment = ['null', 'steemsc', 'steem-peg'];

        if (authorizedAccountContractDeployment.includes(sender)) {
          results = await SmartContracts.deploySmartContract( // eslint-disable-line
            database, transaction, this.blockNumber, this.timestamp,
            this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
          );
        } else {
          results = { logs: { errors: ['the contract deployment is currently unavailable'] } };
        }
      } else {
        results = await SmartContracts.executeSmartContract(// eslint-disable-line
          database, transaction, this.blockNumber, this.timestamp,
          this.refSteemBlockId, this.prevRefSteemBlockId, jsVMTimeout,
        );
      }
    } else {
      results = { logs: { errors: ['the parameters sender, contract and action are required'] } };
    }

    // get the database hash
    newCurrentDatabaseHash = database.getDatabaseHash();


    // console.log('transac logs', results.logs);
    transaction.addLogs(results.logs);
    transaction.executedCodeHash = results.executedCodeHash || ''; // eslint-disable-line
    transaction.databaseHash = newCurrentDatabaseHash; // eslint-disable-line

    transaction.calculateHash();
  }
}

module.exports.Block = Block;
