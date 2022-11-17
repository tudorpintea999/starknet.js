/* eslint-disable import/extensions */
import BN from 'bn.js';
import { keccak256 } from 'ethereum-cryptography/keccak';
import { hexToBytes } from 'ethereum-cryptography/utils';
import { keccak as micro_keccak, pedersen as micro_pedersen } from 'micro-starknet';
import assert from 'minimalistic-assert';

import {
  API_VERSION,
  CONSTANT_POINTS,
  FIELD_PRIME,
  MASK_250,
  ONE,
  StarknetChainId,
  TransactionHashPrefix,
  ZERO,
} from '../constants';
import { CompiledContract, RawCalldata } from '../types/lib';
import { ec } from './ellipticCurve';
import { addHexPrefix, buf2hex, removeHexPrefix, utf8ToArray } from './encode';
import { parse, stringify } from './json';
import {
  BigNumberish,
  isHex,
  isStringWholeNumber,
  toBN,
  toFelt,
  toHex,
  toHexString,
} from './number';
import { encodeShortString } from './shortString';

export const transactionVersion = 1;
export const feeTransactionVersion = toBN(2).pow(toBN(128)).add(toBN(transactionVersion));

export function keccakBn(value: BigNumberish): string {
  const hexWithoutPrefix = removeHexPrefix(toHex(toBN(value)));
  const evenHex = hexWithoutPrefix.length % 2 === 0 ? hexWithoutPrefix : `0${hexWithoutPrefix}`;
  return addHexPrefix(buf2hex(keccak256(hexToBytes(evenHex))));
}

function keccakHex(value: string): string {
  return addHexPrefix(buf2hex(keccak256(utf8ToArray(value))));
}

/**
 * Function to get the starknet keccak hash from a string
 *
 * [Reference](https://github.com/starkware-libs/cairo-lang/blob/master/src/starkware/starknet/public/abi.py#L17-L22)
 * @param value - string you want to get the starknetKeccak hash from
 * @returns starknet keccak hash as BigNumber
 */
export function starknetKeccak(value: string): BN {
  return toBN(keccakHex(value)).and(MASK_250);
}

/**
 * Function to get the hex selector from a given function name
 *
 * [Reference](https://github.com/starkware-libs/cairo-lang/blob/master/src/starkware/starknet/public/abi.py#L25-L26)
 * @param funcName - selectors abi function name
 * @returns hex selector of given abi function name
 */
export function getSelectorFromName(funcName: string) {
  // sometimes BigInteger pads the hex string with zeros, which is not allowed in the starknet api
  return toHex(starknetKeccak(funcName));
}

/**
 * Function to get hex selector from function name, decimal string or hex string
 * @param value hex string | decimal string | string
 * @returns Hex selector
 */
export function getSelector(value: string) {
  if (isHex(value)) {
    return value;
  }
  if (isStringWholeNumber(value)) {
    return toHexString(value);
  }
  return getSelectorFromName(value);
}

const constantPoints = CONSTANT_POINTS.map((coords: string[]) =>
  ec.curve.point(coords[0], coords[1])
);

export function pedersen__old(input: [BigNumberish, BigNumberish]) {
  let point = constantPoints[0];
  for (let i = 0; i < input.length; i += 1) {
    let x = toBN(input[i]);
    assert(x.gte(ZERO) && x.lt(toBN(addHexPrefix(FIELD_PRIME))), `Invalid input: ${input[i]}`);
    if (!x.isZero()) {
      for (let j = 0; j < 252; j += 1) {
        const pt = constantPoints[2 + i * 252 + j];
        assert(!point.getX().eq(pt.getX()));
        if (x.and(ONE).toNumber() !== 0) {
          point = point.add(pt);
        }
        x = x.shrn(1);
      }
    }
  }
  return addHexPrefix(point.getX().toString(16));
}

export type PedersenArg = bigint | number | string;

export function pedersen(input: [PedersenArg, PedersenArg]) {
  return addHexPrefix(micro_pedersen(...input));
}

export function computeHashOnElements(data: BigNumberish[]) {
  const hexData = data.map((d) => toHex(toBN(d)));

  return [...hexData, hexData.length]
    .reduce((x: PedersenArg, y: PedersenArg) => pedersen([x, y]), 0)
    .toString();
}

export function computeHashOnElements__old(data: BigNumberish[]) {
  return [...data, data.length]
    .reduce((x, y) => {
      return pedersen__old([x, y]);
    }, 0)
    .toString();
}

// following implementation is based on this python implementation:
// https://github.com/starkware-libs/cairo-lang/blob/b614d1867c64f3fb2cf4a4879348cfcf87c3a5a7/src/starkware/starknet/core/os/transaction_hash/transaction_hash.py

export function calculateTransactionHashCommon(
  txHashPrefix: TransactionHashPrefix,
  version: BigNumberish,
  contractAddress: BigNumberish,
  entryPointSelector: BigNumberish,
  calldata: BigNumberish[],
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  additionalData: BigNumberish[] = []
): string {
  const calldataHash = computeHashOnElements(calldata);
  const dataToHash = [
    txHashPrefix,
    version,
    contractAddress,
    entryPointSelector,
    calldataHash,
    maxFee,
    chainId,
    ...additionalData,
  ];
  return computeHashOnElements(dataToHash);
}

export function calculateDeployTransactionHash(
  contractAddress: BigNumberish,
  constructorCalldata: BigNumberish[],
  version: BigNumberish,
  chainId: StarknetChainId
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.DEPLOY,
    version,
    contractAddress,
    getSelectorFromName('constructor'),
    constructorCalldata,
    ZERO,
    chainId
  );
}

export function calculateDeclareTransactionHash(
  // contractClass: ContractClass, // Should be used once class hash is present in ContractClass
  classHash: BigNumberish,
  senderAddress: BigNumberish,
  version: BigNumberish,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.DECLARE,
    version,
    senderAddress,
    0,
    [classHash],
    maxFee,
    chainId,
    [nonce]
  );
}

export function calculateDeployAccountTransactionHash(
  contractAddress: BigNumberish,
  classHash: BigNumberish,
  constructorCalldata: BigNumberish[],
  salt: BigNumberish,
  version: BigNumberish,
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish
) {
  const calldata = [classHash, salt, ...constructorCalldata];

  return calculateTransactionHashCommon(
    TransactionHashPrefix.DEPLOY_ACCOUNT,
    version,
    contractAddress,
    0,
    calldata,
    maxFee,
    chainId,
    [nonce]
  );
}

export function calculateTransactionHash(
  contractAddress: BigNumberish,
  version: BigNumberish,
  calldata: BigNumberish[],
  maxFee: BigNumberish,
  chainId: StarknetChainId,
  nonce: BigNumberish
): string {
  return calculateTransactionHashCommon(
    TransactionHashPrefix.INVOKE,
    version,
    contractAddress,
    0,
    calldata,
    maxFee,
    chainId,
    [nonce]
  );
}

export function calculateContractAddressFromHash(
  salt: BigNumberish,
  classHash: BigNumberish,
  constructorCalldata: RawCalldata,
  deployerAddress: BigNumberish
) {
  const constructorCalldataHash = computeHashOnElements(constructorCalldata);

  const CONTRACT_ADDRESS_PREFIX = toFelt('0x535441524b4e45545f434f4e54524143545f41444452455353'); // Equivalent to 'STARKNET_CONTRACT_ADDRESS'

  const dataToHash = [
    CONTRACT_ADDRESS_PREFIX,
    deployerAddress,
    salt,
    classHash,
    constructorCalldataHash,
  ];

  return computeHashOnElements(dataToHash);
}

export default function computeHintedClassHash(compiledContract: CompiledContract) {
  const { abi, program } = compiledContract;

  const serialisedJson = stringify({ abi, program });

  return addHexPrefix(micro_keccak(utf8ToArray(serialisedJson)).toString(16));
}

// Computes the class hash of a given contract class
export function computeContractClassHash(contract: CompiledContract | string) {
  const compiledContract =
    typeof contract === 'string' ? (parse(contract) as CompiledContract) : contract;

  const apiVersion = toHex(API_VERSION);

  const externalEntryPointsHash = computeHashOnElements(
    compiledContract.entry_points_by_type.EXTERNAL.flatMap((e) => [e.selector, e.offset])
  );
  console.log(
    '🚀 ~ file: hash.ts ~ line 278 ~ computeContractClassHash ~ externalEntryPointsHash',
    externalEntryPointsHash
  );

  const l1HandlerEntryPointsHash = computeHashOnElements(
    compiledContract.entry_points_by_type.L1_HANDLER.flatMap((e) => [e.selector, e.offset])
  );
  console.log(
    '🚀 ~ file: hash.ts ~ line 283 ~ computeContractClassHash ~ l1HandlerEntryPointsHash',
    l1HandlerEntryPointsHash
  );

  const constructorEntryPointHash = computeHashOnElements(
    compiledContract.entry_points_by_type.CONSTRUCTOR.flatMap((e) => [e.selector, e.offset])
  );
  console.log(
    '🚀 ~ file: hash.ts ~ line 288 ~ computeContractClassHash ~ constructorEntryPointHash',
    constructorEntryPointHash
  );

  const builtinsHash = computeHashOnElements(
    compiledContract.program.builtins.map((s) => encodeShortString(s))
  );
  console.log(
    '🚀 ~ file: hash.ts ~ line 293 ~ computeContractClassHash ~ builtinsHash',
    builtinsHash
  );

  const hintedClassHash = computeHintedClassHash(compiledContract);
  console.log(
    '🚀 ~ file: hash.ts ~ line 296 ~ computeContractClassHash ~ hintedClassHash',
    hintedClassHash
  );

  const dataHash = computeHashOnElements(compiledContract.program.data);
  console.log('🚀 ~ file: hash.ts ~ line 299 ~ computeContractClassHash ~ dataHash', dataHash);

  const elements: string[] = [
    apiVersion,
    externalEntryPointsHash,
    l1HandlerEntryPointsHash,
    constructorEntryPointHash,
    builtinsHash,
    hintedClassHash,
    dataHash,
  ];
  console.log('🚀 ~ file: hash.ts ~ line 310 ~ computeContractClassHash ~ elements', elements);

  return computeHashOnElements__old(elements);
}
