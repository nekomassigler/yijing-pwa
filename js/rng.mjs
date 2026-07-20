import { createFortuneResult } from "./domain.mjs";

function validateByte(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError("ByteSource must return an integer in 0..255");
  }
  return value;
}

function validateByteSource(byteSource) {
  if (!byteSource || typeof byteSource.nextByte !== "function") {
    throw new TypeError("byteSource must provide nextByte()");
  }
}

export class ArrayByteSource {
  constructor(values) {
    if (!Array.isArray(values) && !(values instanceof Uint8Array)) {
      throw new TypeError("values must be an array of bytes");
    }
    this.values = Array.from(values, validateByte);
    this.position = 0;
    this._requestSizes = [];
  }

  get consumedBytes() {
    return this.position;
  }

  get remainingBytes() {
    return this.values.length - this.position;
  }

  get requestSizes() {
    return this._requestSizes.slice();
  }

  async nextByte() {
    this._requestSizes.push(1);
    if (this.position >= this.values.length) {
      throw new RangeError("ArrayByteSource was exhausted");
    }
    const value = this.values[this.position];
    this.position += 1;
    return value;
  }
}

export async function getRandomBit(byteSource) {
  validateByteSource(byteSource);
  return validateByte(await byteSource.nextByte()) & 1;
}

export async function generateYinYang(byteSource) {
  validateByteSource(byteSource);
  const lines = [];
  for (let index = 0; index < 6; index += 1) {
    lines.push(await getRandomBit(byteSource));
  }
  return lines;
}

export async function selectChangingIndex(byteSource) {
  validateByteSource(byteSource);
  while (true) {
    const value = validateByte(await byteSource.nextByte());
    if (value < 252) {
      return value % 6;
    }
  }
}

export async function performFortune(
  theme,
  byteSource,
  getHexagramName,
) {
  const lines = await generateYinYang(byteSource);
  const changingIndex = await selectChangingIndex(byteSource);
  return createFortuneResult(theme, lines, changingIndex, getHexagramName);
}
