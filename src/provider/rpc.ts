import {
  HEX_STR_TRANSACTION_VERSION_1,
  HEX_STR_TRANSACTION_VERSION_2,
  StarknetChainId,
} from '../constants';
import {
  AccountInvocationItem,
  AccountInvocations,
  BigNumberish,
  BlockIdentifier,
  BlockTag,
  Call,
  ContractVersion,
  DeclareContractTransaction,
  DeployAccountContractTransaction,
  GetCodeResponse,
  Invocation,
  InvocationsDetailsWithNonce,
  RPC,
  RpcProviderOptions,
  TransactionType,
  getContractVersionOptions,
  getEstimateFeeBulkOptions,
  getSimulateTransactionOptions,
  waitForTransactionOptions,
} from '../types';
import { CallData } from '../utils/calldata';
import { getAbiContractVersion } from '../utils/calldata/cairo';
import { isSierra } from '../utils/contract';
import { pascalToSnake } from '../utils/encode';
import fetch from '../utils/fetchPonyfill';
import { getSelectorFromName, getVersionsByType } from '../utils/hash';
import { stringify } from '../utils/json';
import { toHex, toStorageKey } from '../utils/num';
import { wait } from '../utils/provider';
import { RPCResponseParser } from '../utils/responseParser/rpc';
import { decompressProgram, signatureToHexArray } from '../utils/stark';
import { LibraryError } from './errors';
import { ProviderInterface } from './interface';
import { getAddressFromStarkName, getStarkName } from './starknetId';
import { Block } from './utils';

const defaultOptions = {
  headers: { 'Content-Type': 'application/json' },
  blockIdentifier: BlockTag.pending,
  retries: 200,
};

export class RpcProvider implements ProviderInterface {
  public nodeUrl: string;

  public headers: object;

  private responseParser = new RPCResponseParser();

  private retries: number;

  private blockIdentifier: BlockIdentifier;

  private chainId?: StarknetChainId;

  constructor(optionsOrProvider: RpcProviderOptions) {
    const { nodeUrl, retries, headers, blockIdentifier, chainId } = optionsOrProvider;
    this.nodeUrl = nodeUrl;
    this.retries = retries || defaultOptions.retries;
    this.headers = { ...defaultOptions.headers, ...headers };
    this.blockIdentifier = blockIdentifier || defaultOptions.blockIdentifier;
    this.chainId = chainId;
    this.getChainId(); // internally skipped if chainId has value
  }

  public fetch(method: string, params?: object, id: string | number = 0) {
    const rpcRequestBody: RPC.JRPC.RequestBody = { id, jsonrpc: '2.0', method, params };
    return fetch(this.nodeUrl, {
      method: 'POST',
      body: stringify(rpcRequestBody),
      headers: this.headers as Record<string, string>,
    });
  }

  protected errorHandler(rpcError?: RPC.JRPC.Error, otherError?: any) {
    if (rpcError) {
      const { code, message, data } = rpcError;
      throw new LibraryError(`${code}: ${message}: ${data}`);
    }
    if (otherError) {
      throw Error(otherError.message);
    }
  }

  protected async fetchEndpoint<T extends keyof RPC.Methods>(
    method: T,
    params?: RPC.Methods[T]['params']
  ): Promise<RPC.Methods[T]['result']> {
    try {
      const rawResult = await this.fetch(method, params);
      const { error, result } = await rawResult.json();
      this.errorHandler(error);
      return result as RPC.Methods[T]['result'];
    } catch (error: any) {
      this.errorHandler(error?.response?.data, error);
      throw error;
    }
  }

  public async getChainId() {
    this.chainId ??= (await this.fetchEndpoint('starknet_chainId')) as StarknetChainId;
    return this.chainId;
  }

  public async getBlock(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    return this.getBlockWithTxHashes(blockIdentifier).then(
      this.responseParser.parseGetBlockResponse
    );
  }

  public async getBlockHashAndNumber() {
    return this.fetchEndpoint('starknet_blockHashAndNumber');
  }

  public async getBlockWithTxHashes(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockWithTxHashes', { block_id });
  }

  public async getBlockWithTxs(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockWithTxs', { block_id });
  }

  public async getClassHashAt(
    contractAddress: RPC.ContractAddress,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClassHashAt', {
      block_id,
      contract_address: contractAddress,
    });
  }

  public async getNonceForAddress(
    contractAddress: string,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getNonce', {
      contract_address: contractAddress,
      block_id,
    });
  }

  /**
   * Return transactions from pending block
   * @deprecated Instead use getBlock(BlockTag.pending);
   */
  public async getPendingTransactions() {
    const { transactions } = await this.getBlock(BlockTag.pending);
    return Promise.all(transactions.map((it) => this.getTransactionByHash(it)));
  }

  /**
   * NEW: Returns the version of the Starknet JSON-RPC specification being used
   */
  public async getSpecVersion() {
    return this.fetchEndpoint('starknet_specVersion');
  }

  public async getStateUpdate(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getStateUpdate', { block_id });
  }

  public async getStorageAt(
    contractAddress: string,
    key: BigNumberish,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const parsedKey = toStorageKey(key);
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getStorageAt', {
      contract_address: contractAddress,
      key: parsedKey,
      block_id,
    });
  }

  public async getTransaction(txHash: string) {
    return this.getTransactionByHash(txHash).then(this.responseParser.parseGetTransactionResponse);
  }

  public async getTransactionByHash(txHash: string) {
    return this.fetchEndpoint('starknet_getTransactionByHash', { transaction_hash: txHash });
  }

  public async getTransactionByBlockIdAndIndex(blockIdentifier: BlockIdentifier, index: number) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getTransactionByBlockIdAndIndex', { block_id, index });
  }

  public async getTransactionReceipt(txHash: string) {
    return this.fetchEndpoint('starknet_getTransactionReceipt', { transaction_hash: txHash });
  }

  public async getClassByHash(classHash: RPC.Felt) {
    return this.getClass(classHash);
  }

  public async getClass(
    classHash: RPC.Felt,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClass', {
      class_hash: classHash,
      block_id,
    }).then(this.responseParser.parseContractClassResponse);
  }

  public async getClassAt(
    contractAddress: string,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getClassAt', {
      block_id,
      contract_address: contractAddress,
    }).then(this.responseParser.parseContractClassResponse);
  }

  public async getCode(
    _contractAddress: string,
    _blockIdentifier?: BlockIdentifier
  ): Promise<GetCodeResponse> {
    throw new Error('RPC does not implement getCode function');
  }

  public async getContractVersion(
    contractAddress: string,
    classHash?: undefined,
    options?: getContractVersionOptions
  ): Promise<ContractVersion>;
  public async getContractVersion(
    contractAddress: undefined,
    classHash: string,
    options?: getContractVersionOptions
  ): Promise<ContractVersion>;

  public async getContractVersion(
    contractAddress?: string,
    classHash?: string,
    { blockIdentifier = this.blockIdentifier, compiler = true }: getContractVersionOptions = {}
  ): Promise<ContractVersion> {
    let contractClass;
    if (contractAddress) {
      contractClass = await this.getClassAt(contractAddress, blockIdentifier);
    } else if (classHash) {
      contractClass = await this.getClass(classHash, blockIdentifier);
    } else {
      throw Error('getContractVersion require contractAddress or classHash');
    }

    if (isSierra(contractClass)) {
      if (compiler) {
        const abiTest = getAbiContractVersion(contractClass.abi);
        return { cairo: '1', compiler: abiTest.compiler };
      }
      return { cairo: '1', compiler: undefined };
    }
    return { cairo: '0', compiler: '0' };
  }

  public async getEstimateFee(
    invocation: Invocation,
    invocationDetails: InvocationsDetailsWithNonce,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    return this.getInvokeEstimateFee(invocation, invocationDetails, blockIdentifier);
  }

  public async getInvokeEstimateFee(
    invocation: Invocation,
    invocationDetails: InvocationsDetailsWithNonce,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    const transaction = this.buildTransaction(
      {
        type: TransactionType.INVOKE,
        ...invocation,
        ...invocationDetails,
      },
      'fee'
    );
    return this.fetchEndpoint('starknet_estimateFee', {
      request: [transaction],
      block_id,
    }).then(this.responseParser.parseFeeEstimateResponse);
  }

  public async getDeclareEstimateFee(
    invocation: DeclareContractTransaction,
    details: InvocationsDetailsWithNonce,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    const transaction = this.buildTransaction(
      {
        type: TransactionType.DECLARE,
        ...invocation,
        ...details,
      },
      'fee'
    );
    return this.fetchEndpoint('starknet_estimateFee', {
      request: [transaction],
      block_id,
    }).then(this.responseParser.parseFeeEstimateResponse);
  }

  public async getDeployAccountEstimateFee(
    invocation: DeployAccountContractTransaction,
    details: InvocationsDetailsWithNonce,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    const transaction = this.buildTransaction(
      {
        type: TransactionType.DEPLOY_ACCOUNT,
        ...invocation,
        ...details,
      },
      'fee'
    );
    return this.fetchEndpoint('starknet_estimateFee', {
      request: [transaction],
      block_id,
    }).then(this.responseParser.parseFeeEstimateResponse);
  }

  public async getEstimateFeeBulk(
    invocations: AccountInvocations,
    { blockIdentifier = this.blockIdentifier, skipValidate = false }: getEstimateFeeBulkOptions
  ) {
    if (skipValidate) {
      // eslint-disable-next-line no-console
      console.warn('getEstimateFeeBulk RPC does not support skipValidate');
    }
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_estimateFee', {
      request: invocations.map((it) => this.buildTransaction(it, 'fee')),
      block_id,
    }).then(this.responseParser.parseFeeEstimateBulkResponse);
  }

  public async declareContract(
    { contract, signature, senderAddress, compiledClassHash }: DeclareContractTransaction,
    details: InvocationsDetailsWithNonce
  ) {
    if (!isSierra(contract)) {
      return this.fetchEndpoint('starknet_addDeclareTransaction', {
        declare_transaction: {
          type: RPC.ETransactionType.DECLARE,
          contract_class: {
            program: contract.program,
            entry_points_by_type: contract.entry_points_by_type,
            abi: contract.abi,
          },
          version: HEX_STR_TRANSACTION_VERSION_1,
          max_fee: toHex(details.maxFee || 0),
          signature: signatureToHexArray(signature),
          sender_address: senderAddress,
          nonce: toHex(details.nonce),
        },
      });
    }
    return this.fetchEndpoint('starknet_addDeclareTransaction', {
      declare_transaction: {
        type: RPC.ETransactionType.DECLARE,
        contract_class: {
          sierra_program: decompressProgram(contract.sierra_program),
          contract_class_version: contract.contract_class_version,
          entry_points_by_type: contract.entry_points_by_type,
          abi: contract.abi,
        },
        compiled_class_hash: compiledClassHash || '',
        version: HEX_STR_TRANSACTION_VERSION_2,
        max_fee: toHex(details.maxFee || 0),
        signature: signatureToHexArray(signature),
        sender_address: senderAddress,
        nonce: toHex(details.nonce),
      },
    });
  }

  public async deployAccountContract(
    { classHash, constructorCalldata, addressSalt, signature }: DeployAccountContractTransaction,
    details: InvocationsDetailsWithNonce
  ) {
    return this.fetchEndpoint('starknet_addDeployAccountTransaction', {
      deploy_account_transaction: {
        constructor_calldata: CallData.toHex(constructorCalldata || []),
        class_hash: toHex(classHash),
        contract_address_salt: toHex(addressSalt || 0),
        type: RPC.ETransactionType.DEPLOY_ACCOUNT,
        max_fee: toHex(details.maxFee || 0),
        version: toHex(details.version || 0),
        signature: signatureToHexArray(signature),
        nonce: toHex(details.nonce),
      },
    });
  }

  public async invokeFunction(
    functionInvocation: Invocation,
    details: InvocationsDetailsWithNonce
  ) {
    return this.fetchEndpoint('starknet_addInvokeTransaction', {
      invoke_transaction: {
        sender_address: functionInvocation.contractAddress,
        calldata: CallData.toHex(functionInvocation.calldata),
        type: RPC.ETransactionType.INVOKE,
        max_fee: toHex(details.maxFee || 0),
        version: '0x1',
        signature: signatureToHexArray(functionInvocation.signature),
        nonce: toHex(details.nonce),
      },
    });
  }

  public async callContract(call: Call, blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    const result = await this.fetchEndpoint('starknet_call', {
      request: {
        contract_address: call.contractAddress,
        entry_point_selector: getSelectorFromName(call.entrypoint),
        calldata: CallData.toHex(call.calldata),
      },
      block_id,
    });

    return this.responseParser.parseCallContractResponse(result);
  }

  public async traceTransaction(transactionHash: RPC.TransactionHash) {
    return this.fetchEndpoint('starknet_traceTransaction', { transaction_hash: transactionHash });
  }

  // TODO: implement in waitforTransaction, add add tests, when RPC 0.5 become standard /
  /**
   * NEW: Get the status of a transaction
   * @param transactionHash
   */
  public async getTransactionStatus(transactionHash: BigNumberish) {
    const transaction_hash = toHex(transactionHash);
    return this.fetchEndpoint('starknet_getTransactionStatus', {
      transaction_hash,
    });
  }

  // TODO: add tests
  /**
   * NEW: Estimate the fee for a message from L1
   * @param message Message From L1
   * @param blockIdentifier
   */
  public async estimateMessageFee(
    message: RPC.L1Message,
    blockIdentifier: BlockIdentifier = this.blockIdentifier
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_estimateMessageFee', {
      message,
      block_id,
    });
  }

  public async traceBlockTransactions(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_traceBlockTransactions', { block_id });
  }

  public async waitForTransaction(txHash: string, options?: waitForTransactionOptions) {
    let { retries } = this;
    let onchain = false;
    let isErrorState = false;
    let txReceipt: any = {};
    const retryInterval = options?.retryInterval ?? 5000;
    const errorStates: any = options?.errorStates ?? [RPC.TransactionExecutionStatus.REVERTED];
    const successStates: any = options?.successStates ?? [
      RPC.TransactionExecutionStatus.SUCCEEDED,
      RPC.TransactionFinalityStatus.ACCEPTED_ON_L1,
      RPC.TransactionFinalityStatus.ACCEPTED_ON_L2,
    ];

    while (!onchain) {
      // eslint-disable-next-line no-await-in-loop
      await wait(retryInterval);
      try {
        // eslint-disable-next-line no-await-in-loop
        txReceipt = await this.getTransactionReceipt(txHash);

        // TODO: Hotfix until Pathfinder release fixed casing
        const executionStatus = pascalToSnake(txReceipt.execution_status);
        const finalityStatus = pascalToSnake(txReceipt.finality_status);

        if (!executionStatus || !finalityStatus) {
          // Transaction is potentially REJECTED or NOT_RECEIVED but RPC doesn't have dose statuses
          // so we will retry '{ retries }' times
          const error = new Error('waiting for transaction status');
          throw error;
        }

        if (successStates.includes(executionStatus) || successStates.includes(finalityStatus)) {
          onchain = true;
        } else if (errorStates.includes(executionStatus) || errorStates.includes(finalityStatus)) {
          const message = `${executionStatus}: ${finalityStatus}: ${txReceipt.revert_reason}`;
          const error = new Error(message) as Error & { response: RPC.TransactionReceipt };
          error.response = txReceipt;
          isErrorState = true;
          throw error;
        }
      } catch (error) {
        if (error instanceof Error && isErrorState) {
          throw error;
        }

        if (retries === 0) {
          throw new Error(`waitForTransaction timed-out with retries ${this.retries}`);
        }
      }

      retries -= 1;
    }

    await wait(retryInterval);
    return txReceipt;
  }

  /**
   * Get the number of transactions in a block given a block id
   * @param blockIdentifier
   * @returns Number of transactions
   */
  public async getTransactionCount(blockIdentifier: BlockIdentifier = this.blockIdentifier) {
    const block_id = new Block(blockIdentifier).identifier;
    return this.fetchEndpoint('starknet_getBlockTransactionCount', { block_id });
  }

  /**
   * Get the most recent accepted block number
   * @returns Number of the latest block
   */
  public async getBlockNumber() {
    return this.fetchEndpoint('starknet_blockNumber');
  }

  /**
   * Returns an object about the sync status, or false if the node is not synching
   * @returns Object with the stats data
   */
  public async getSyncingStats() {
    return this.fetchEndpoint('starknet_syncing');
  }

  /**
   * Returns all events matching the given filter
   * @returns events and the pagination of the events
   */
  public async getEvents(eventFilter: RPC.EventFilter) {
    return this.fetchEndpoint('starknet_getEvents', { filter: eventFilter });
  }

  /**
   * @param invocations AccountInvocations
   * @param simulateTransactionOptions blockIdentifier and flags to skip validation and fee charge
   * - blockIdentifier
   * - skipValidate (default false)
   * - skipFeeCharge (default true)
   */
  public async getSimulateTransaction(
    invocations: AccountInvocations,
    {
      blockIdentifier = this.blockIdentifier,
      skipValidate = false,
      skipFeeCharge = true,
    }: getSimulateTransactionOptions
  ) {
    const block_id = new Block(blockIdentifier).identifier;
    const simulationFlags = [];
    if (skipValidate) simulationFlags.push(RPC.ESimulationFlag.SKIP_VALIDATE);
    if (skipFeeCharge) simulationFlags.push(RPC.ESimulationFlag.SKIP_FEE_CHARGE);

    return this.fetchEndpoint('starknet_simulateTransactions', {
      block_id,
      transactions: invocations.map((it) => this.buildTransaction(it)),
      simulation_flags: simulationFlags,
    }).then(this.responseParser.parseSimulateTransactionResponse);
  }

  public async getStarkName(address: BigNumberish, StarknetIdContract?: string) {
    return getStarkName(this, address, StarknetIdContract);
  }

  public async getAddressFromStarkName(name: string, StarknetIdContract?: string) {
    return getAddressFromStarkName(this, name, StarknetIdContract);
  }

  public buildTransaction(
    invocation: AccountInvocationItem,
    versionType?: 'fee' | 'transaction'
  ): RPC.BaseTransaction {
    const defaultVersions = getVersionsByType(versionType);
    const details = {
      signature: signatureToHexArray(invocation.signature),
      nonce: toHex(invocation.nonce),
      max_fee: toHex(invocation.maxFee || 0),
    };

    if (invocation.type === TransactionType.INVOKE) {
      return {
        type: RPC.ETransactionType.INVOKE, // Diff between sequencer and rpc invoke type
        sender_address: invocation.contractAddress,
        calldata: CallData.toHex(invocation.calldata),
        version: toHex(invocation.version || defaultVersions.v1),
        ...details,
      };
    }
    if (invocation.type === TransactionType.DECLARE) {
      if (!isSierra(invocation.contract)) {
        return {
          type: invocation.type,
          contract_class: invocation.contract,
          sender_address: invocation.senderAddress,
          version: toHex(invocation.version || defaultVersions.v1),
          ...details,
        };
      }
      return {
        // compiled_class_hash
        type: invocation.type,
        contract_class: {
          ...invocation.contract,
          sierra_program: decompressProgram(invocation.contract.sierra_program),
        },
        compiled_class_hash: invocation.compiledClassHash || '',
        sender_address: invocation.senderAddress,
        version: toHex(invocation.version || defaultVersions.v2),
        ...details,
      };
    }
    if (invocation.type === TransactionType.DEPLOY_ACCOUNT) {
      return {
        type: invocation.type,
        constructor_calldata: CallData.toHex(invocation.constructorCalldata || []),
        class_hash: toHex(invocation.classHash),
        contract_address_salt: toHex(invocation.addressSalt || 0),
        version: toHex(invocation.version || defaultVersions.v1),
        ...details,
      };
    }
    throw Error('RPC buildTransaction received unknown TransactionType');
  }
}
