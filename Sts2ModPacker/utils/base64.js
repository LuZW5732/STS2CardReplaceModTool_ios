// Base64 helpers for React Native / Hermes
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeBase64(base64) {
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === '=') bufferLength--;
  if (base64[base64.length - 2] === '=') bufferLength--;

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const encoded1 = lookup[base64.charCodeAt(i)];
    const encoded2 = lookup[base64.charCodeAt(i + 1)];
    const encoded3 = lookup[base64.charCodeAt(i + 2)];
    const encoded4 = lookup[base64.charCodeAt(i + 3)];

    bytes[p++] = (encoded1 << 2) | (encoded2 >> 4);
    if (encoded3 !== undefined) {
      bytes[p++] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
    }
    if (encoded4 !== undefined) {
      bytes[p++] = ((encoded3 & 3) << 6) | (encoded4 & 63);
    }
  }
  return bytes;
}

export function encodeBase64(uint8Array) {
  let result = '';
  const len = uint8Array.length;
  for (let i = 0; i < len; i += 3) {
    result += chars[uint8Array[i] >> 2];
    result += chars[((uint8Array[i] & 3) << 4) | (uint8Array[i + 1] >> 4)];
    result += chars[((uint8Array[i + 1] & 15) << 2) | (uint8Array[i + 2] >> 6)];
    result += chars[uint8Array[i + 2] & 63];
  }

  const remainder = len % 3;
  if (remainder === 1) {
    result = result.substring(0, result.length - 2) + '==';
  } else if (remainder === 2) {
    result = result.substring(0, result.length - 1) + '=';
  }

  return result;
}
