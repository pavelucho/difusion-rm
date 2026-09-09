/**
 * jpeg-lossless-decoder-js no publica tipos. Solo se usa el decodificador, que
 * devuelve muestras sin signo del ancho declarado en la cabecera JPEG.
 */
declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    decode(buffer: ArrayBufferLike, offset: number, length: number): Uint8Array | Uint16Array;
  }
}
