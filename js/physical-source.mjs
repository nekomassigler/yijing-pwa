import {
  SENSOR_DOMAIN,
  clearMotionSamples,
  collectMotionSamples,
  encodeMotionSamples,
  requestMotionPermission,
} from "./sensor.mjs";
import {
  POINTER_DOMAIN,
  clearPointerSamples,
  collectPointerSamples,
  encodePointerSamples,
} from "./pointer.mjs";

const SHA256_BLOCK_SIZE = 32;
const textEncoder = new TextEncoder();

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function copyUint8Array(value, name, expectedLength = null) {
  let copied;
  if (value instanceof Uint8Array) {
    copied = new Uint8Array(value);
  } else if (value instanceof ArrayBuffer) {
    copied = new Uint8Array(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    copied = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  } else {
    throw new TypeError(`${name} must return binary data`);
  }
  if (expectedLength !== null && copied.length !== expectedLength) {
    copied.fill(0);
    throw new RangeError(`${name} must return exactly ${expectedLength} bytes`);
  }
  return copied;
}

function encodeCounter(counter) {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new RangeError("physical block counter is outside uint32 range");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, counter, false);
  return bytes;
}

function concatenate(parts) {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function createWebCryptoDependencies(
  cryptoImplementation = globalThis.crypto,
) {
  if (
    !cryptoImplementation ||
    typeof cryptoImplementation.getRandomValues !== "function" ||
    typeof cryptoImplementation.subtle?.digest !== "function"
  ) {
    throw new Error("Web Crypto APIを利用できません。");
  }
  return {
    digestImplementation: async (input) =>
      cryptoImplementation.subtle.digest("SHA-256", input),
    randomBlockProvider: async (size) => {
      const block = new Uint8Array(size);
      cryptoImplementation.getRandomValues(block);
      return block;
    },
  };
}

export async function computePhysicalDigest({
  domain,
  canonicalBytes,
  counter,
  digestImplementation,
}) {
  if (typeof domain !== "string" || domain.length === 0) {
    throw new TypeError("physical input domain must be a non-empty string");
  }
  if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
    throw new TypeError("canonicalPhysicalBytes must be a non-empty Uint8Array");
  }
  requireFunction(digestImplementation, "digestImplementation");

  const domainBytes = textEncoder.encode(domain);
  const counterBytes = encodeCounter(counter);
  const digestInput = concatenate([domainBytes, canonicalBytes, counterBytes]);
  domainBytes.fill(0);
  counterBytes.fill(0);
  try {
    const result = await digestImplementation(digestInput);
    return copyUint8Array(result, "digestImplementation", SHA256_BLOCK_SIZE);
  } finally {
    digestInput.fill(0);
  }
}

export class MixedPhysicalByteSource {
  constructor({
    domain,
    canonicalBytes,
    digestImplementation,
    randomBlockProvider,
  }) {
    if (typeof domain !== "string" || domain.length === 0) {
      throw new TypeError("physical input domain must be a non-empty string");
    }
    if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
      throw new TypeError("canonicalPhysicalBytes must be a non-empty Uint8Array");
    }
    this.domain = domain;
    this.canonicalBytes = new Uint8Array(canonicalBytes);
    this.digestImplementation = requireFunction(
      digestImplementation,
      "digestImplementation",
    );
    this.randomBlockProvider = requireFunction(
      randomBlockProvider,
      "randomBlockProvider",
    );
    this.counter = 0;
    this.position = SHA256_BLOCK_SIZE;
    this.currentBlock = null;
    this._consumedBytes = 0;
    this._generatedBlockCount = 0;
    this.disposed = false;
  }

  get consumedBytes() {
    return this._consumedBytes;
  }

  get generatedBlockCount() {
    return this._generatedBlockCount;
  }

  async generateBlock() {
    if (this.counter > 0xffffffff) {
      throw new RangeError("physical ByteSource block counter was exhausted");
    }
    const physicalBlock = await computePhysicalDigest({
      domain: this.domain,
      canonicalBytes: this.canonicalBytes,
      counter: this.counter,
      digestImplementation: this.digestImplementation,
    });
    let cryptoBlock = null;
    try {
      cryptoBlock = copyUint8Array(
        await this.randomBlockProvider(SHA256_BLOCK_SIZE),
        "randomBlockProvider",
        SHA256_BLOCK_SIZE,
      );
      const mixedBlock = new Uint8Array(SHA256_BLOCK_SIZE);
      for (let index = 0; index < SHA256_BLOCK_SIZE; index += 1) {
        mixedBlock[index] = physicalBlock[index] ^ cryptoBlock[index];
      }
      this.currentBlock?.fill(0);
      this.currentBlock = mixedBlock;
      this.position = 0;
      this.counter += 1;
      this._generatedBlockCount += 1;
    } finally {
      physicalBlock.fill(0);
      cryptoBlock?.fill(0);
    }
  }

  async nextByte() {
    if (this.disposed) {
      throw new Error("physical ByteSource has been disposed");
    }
    if (this.position >= SHA256_BLOCK_SIZE) {
      await this.generateBlock();
    }
    const value = this.currentBlock[this.position];
    this.position += 1;
    this._consumedBytes += 1;
    if (this.position >= SHA256_BLOCK_SIZE) {
      this.currentBlock.fill(0);
    }
    return value;
  }

  dispose() {
    this.canonicalBytes.fill(0);
    this.currentBlock?.fill(0);
    this.currentBlock = null;
    this.position = SHA256_BLOCK_SIZE;
    this.disposed = true;
  }
}

export function createPhysicalByteSource({
  domain,
  canonicalBytes,
  cryptoImplementation = globalThis.crypto,
  digestImplementation,
  randomBlockProvider,
} = {}) {
  if (!digestImplementation || !randomBlockProvider) {
    const defaults = createWebCryptoDependencies(cryptoImplementation);
    digestImplementation ??= defaults.digestImplementation;
    randomBlockProvider ??= defaults.randomBlockProvider;
  }
  return new MixedPhysicalByteSource({
    domain,
    canonicalBytes,
    digestImplementation,
    randomBlockProvider,
  });
}

export function createPhysicalInputProvider({
  eventTarget = globalThis.window,
  deviceMotionEventClass = globalThis.DeviceMotionEvent,
  pointerElement,
  cryptoImplementation = globalThis.crypto,
  digestImplementation,
  randomBlockProvider,
  requestMotionPermissionImplementation = requestMotionPermission,
  collectMotionSamplesImplementation = collectMotionSamples,
  encodeMotionSamplesImplementation = encodeMotionSamples,
  clearMotionSamplesImplementation = clearMotionSamples,
  collectPointerSamplesImplementation = collectPointerSamples,
  encodePointerSamplesImplementation = encodePointerSamples,
  clearPointerSamplesImplementation = clearPointerSamples,
  sensorOptions = {},
  pointerOptions = {},
} = {}) {
  return async ({ mode = "motion", onState = () => {}, signal } = {}) => {
    let samples = null;
    let canonicalBytes = null;
    let domain;
    try {
      if (mode === "motion") {
        onState("requesting-motion-permission");
        await requestMotionPermissionImplementation({ deviceMotionEventClass });
        samples = await collectMotionSamplesImplementation({
          eventTarget,
          signal,
          onState,
          ...sensorOptions,
        });
        canonicalBytes = encodeMotionSamplesImplementation(samples);
        domain = SENSOR_DOMAIN;
      } else if (mode === "pointer") {
        samples = await collectPointerSamplesImplementation({
          element: pointerElement,
          signal,
          onState,
          ...pointerOptions,
        });
        canonicalBytes = encodePointerSamplesImplementation(samples);
        domain = POINTER_DOMAIN;
      } else {
        throw new TypeError(`unsupported physical input mode: ${mode}`);
      }
      if (!(canonicalBytes instanceof Uint8Array) || canonicalBytes.length === 0) {
        throw new TypeError("有効な物理入力をバイト列へ変換できませんでした。");
      }
      onState("mixing-physical-source");
      return createPhysicalByteSource({
        domain,
        canonicalBytes,
        cryptoImplementation,
        digestImplementation,
        randomBlockProvider,
      });
    } finally {
      if (mode === "motion") {
        clearMotionSamplesImplementation(samples);
      } else if (mode === "pointer") {
        clearPointerSamplesImplementation(samples);
      }
      canonicalBytes?.fill(0);
      samples = null;
      canonicalBytes = null;
    }
  };
}
