// Cross platform Node.js / Web Browser buffer library
export class Buf {
	constructor(bufOrSize) { // accepts Number or Buffer or ArrayBuffer or TypedArray or DataView
		if (typeof bufOrSize == 'number') this.buf = Buf.isNode ? Buffer.allocUnsafe(bufOrSize) : new DataView(new ArrayBuffer(bufOrSize));
		else this.buf = Buf.isNode ? bufOrSize instanceof ArrayBuffer ? Buffer.from(bufOrSize) : bufOrSize : new DataView(bufOrSize instanceof ArrayBuffer ? bufOrSize : bufOrSize.buffer);
		this.off = 0;
	}
	readString() {
		const length = this.readVarInt();
		const str = length ? Buf.isNode ? this.buf.toString('utf8', this.off, this.off + length) : Buf.textDecoder.decode(new Uint8Array(this.buf.buffer, this.off, length)) : '';
		this.off += length;
		return str;
	}
	writeString(str) {
		if (!Buf.isNode) str = Buf.textEncoder.encode(str);
		const length = Buf.isNode ? Buffer.byteLength(str) : str.length;
		this.writeVarInt(length);
		this.checkSize(length);
		Buf.isNode ? this.buf.write(str, this.off) : new Uint8Array(this.buf.buffer, this.off, length).set(str);
		this.off += length;
	}
	readBlob(bytes) {
		const length = bytes || this.readVarInt();
		const blob = Buf.isNode ? this.buf.subarray(this.off, this.off + length) : new Uint8Array(this.buf.buffer, this.off, length);
		this.off += length;
		return blob;
	}
	writeBlob(buf, bytes) { // Node takes Buffer or TypedArray, Browser takes TypedArray
		const length = bytes || buf.byteLength;
		if (bytes) {
			if (buf.byteLength > bytes) buf = new Uint8Array(buf.buffer, 0, bytes); // zero copy sliced view
			else if (buf.byteLength < bytes) {
				const newBuf = new Uint8Array(bytes); // fill zero
				newBuf.set(buf); // copy
				buf = newBuf;
			}
		} else this.writeVarInt(length);
		this.checkSize(length);
		Buf.isNode && buf instanceof Buffer ? buf.copy(this.buf, this.off, 0, length) : new Uint8Array(this.buf.buffer, this.off, length).set(buf);
		this.off += length;
	}
	readUint(bytes) {
		const int = this.buf[(Buf.isNode ? { 1: 'readUint8', 2: 'readUint16BE', 4: 'readUint32BE' } : { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' })[bytes]](this.off);
		this.off += bytes;
		return int;
	}
	writeUint(val, bytes) {
		this.checkSize(bytes);
		Buf.isNode ? this.buf[({ 1: 'writeUint8', 2: 'writeUint16BE', 4: 'writeUint32BE' })[bytes]](val, this.off) : this.buf[({ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' })[bytes]](this.off, val);
		this.off += bytes;
	}
	readFloat(bytes) {
		const float = this.buf[(Buf.isNode ? { 4: 'readFloatBE', 8: 'readDoubleBE'} : { 4: 'getFloat32', 8: 'getFloat64' })[bytes]](this.off);
		this.off += bytes;
		return float;
	}
	writeFloat(val, bytes) {
		this.checkSize(bytes);
		Buf.isNode ? this.buf[({ 4: 'writeFloatBE', 8: 'writeDoubleBE'})[bytes]](val, this.off) : this.buf[({ 4: 'setFloat32', 8: 'setFloat64'})[bytes]](this.off, val);
		this.off += bytes;
	}
	readVarInt() {
		let val = this.readUint(1);
		if (val < 128) return val;
		this.off--; val = this.readUint(2);
		if (!(val & 0b1000_0000)) return ((val & 0b111_1111_0000_0000) >> 1) | (val & 0b111_1111);
		this.off -= 2; val = this.readUint(4);
		return ((val & 0b111_1111_0000_0000_0000_0000_0000_0000) >> 1) | (val & 0b111_1111_1111_1111_1111_1111);
	}
	writeVarInt(int) {
		if (int < 128) return this.writeUint(int, 1);
		if (int < 16_384) return this.writeUint(((int & 0b11_1111_1000_0000) << 1) | (int & 0b111_1111) | 0b1000_0000_0000_0000, 2);
		if (int < 1_073_741_824) return this.writeUint(((int & 0b11_1111_1000_0000_0000_0000_0000_0000) << 1) | (int & 0b111_1111_1111_1111_1111_1111) | 0b1000_0000_1000_0000_0000_0000_0000_0000, 4);
		throw Error(`varInt max 1,073,741,823 exceeded: ${int}`);
	}
	checkSize(bytes) {
		const length = this.length;
		if (bytes + this.off > length) {
			console.log('RESIZE BUFFER', bytes, this.off, length);
			if (Buf.isNode) {
				const newBuf = Buffer.allocUnsafe(length * 2);
				this.buf.copy(newBuf);
				this.buf = newBuf;
			} else {
				this.buf = new DataView(this.buf.buffer.transfer(length * 2));
			}
		}
	}
	get buffer() { return this.buf; }
	get length() { return Buf.isNode ? this.buf.length : this.buf.byteLength; }
	get hasMore() { return this.off < this.length; }
	static getVarIntSize(int) { return int < 128 ? 1 : int < 16_384 ? 2 : 4; }
	static strByteLength(str = '') { if (Buf.isNode) return Buffer.byteLength(str); let s = str.length; for (let i = str.length - 1; i >= 0; i--) { const code = str.charCodeAt(i); if (code > 0x7f && code <= 0x7ff) s++; else if (code > 0x7ff && code <= 0xffff) s += 2; if (code >= 0xDC00 && code <= 0xDFFF) i--; } return s; }
	static strTotalLength(str = '') { const length = Buf.strByteLength(str); return length + Buf.getVarIntSize(length); }
	static length(buf) { return Buf.isNode ? buf.length : buf.byteLength; }
	static isNode = typeof window != 'object';
	static textEncoder = !Buf.isNode && new TextEncoder();
	static textDecoder = !Buf.isNode && new TextDecoder();
	static byteToHex = Array.from(Array(256)).map((a, i) => i.toString(16).padStart(2, '0'));
}
