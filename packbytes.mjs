class Type { // schema types
	constructor(type, val) {
		if (!val) {
			const fn = (...val) => new Type(type, val);
			fn.toJSON = () => ({ _type: type });
			fn._type = type;
			return fn;
		}
		this._type = type;
		this.val = val.length > 1 ? val : val[0];
	}
	size(size) { this._size = size; return this; }
	static types = [ 'bool', 'bits', 'float', 'string', 'blob', 'array', 'schemas' ];
}
export const [ bool, bits, float, string, blob, array, schemas ] = Type.types.map(t => new Type(t));

export class PackBytes { // encoder and decoder
	constructor(schema) {
		this.schema = typeof schema == 'string' ? JSON.parse(schema) : schema;
		this.scanSchema(this.schema);
	}
	encode(schema, data) {
		data = data ? [ schema, data ] : schema;
		this.buf = new Buf(null, this.getDataSize(data, this.schema));
		this.writeSchema(this.schema, data);
		return this.buf.buf;
	}
	decode(buf) {
		this.buf = new Buf(buf);
		return this.readSchema(this.schema);
	}
	scanSchema(schema, o, parentField) {
		switch (schema._type) {
			case 'bool': break;
			case 'bits': schema.bytes = Math.ceil(schema.val / 8); break;
			case 'float': schema.bytes = schema.val / 8; break;
			case 'string': if (schema.val) PackBytes.genMap(schema, schema.val); break;
			case 'blob': break;
			case 'array': this.scanSchema(schema.val); break;
			case 'schemas': PackBytes.genMap(schema, Object.keys(schema.val)); Object.values(schema.val).forEach(s => this.scanSchema(s)); break;
			default: // object
				if (!o) o = schema[PackBytes.objSchema] = PackBytes.newObjSchema();
				for (let field in schema) {
					const type = schema[field];
					if (parentField) field = parentField.concat(field);
					switch (type._type) {
						case 'bool': o.ints.push({ field, bits: 1, bool: true }); break;
						case 'bits': o.ints.push({ field, bits: type.val }); break;
						case 'float': o.floats.push({ field, bytes: type.val / 8 }); break;
						case 'string': if (type.bits) { o.ints.push({ field, bits: type.bits, string: type }); this.scanSchema(type); } else o.strings.push({ field }); break;
						case 'blob': o.blobs.push({ field, bytes: type.val }); break;
						case 'array': o.arrays.push({ field, val: type }); this.scanSchema(type.val); break;
						case 'schemas': o.schemas.push({ field, val: type }); this.scanSchema(type); break;
						default: this.scanSchema(type, o, parentField ? field : [ field ]);
				}}
				if (!parentField) PackBytes.packInts(o);
		}
	}
	getDataSize(data, schema, isChild) {
		switch (schema._type) {
			case 'bool': return 1;
			case 'bits': return schema.bytes;
			case 'float': return schema.bytes;
			case 'string': return schema.bytes || Buf.strTotalLength(data);
			case 'blob': return schema.val || data.length || data.byteLength;
			case 'array': 
				const size = !schema._size && isChild ? Buf.getVarIntSize(data.length) : 0;
				const type = schema.val;
				switch (type._type) {
					case 'bool': return size + data.length;
					case 'bits': return size + data.length * type.bytes;
					case 'float': return size + data.length * type.bytes;
					case 'string': return size + (data.length * type.bytes || data.reduce((total, str) => Buf.strTotalLength(str) + total, 0));
					case 'blob': return size + (data.length * type.val || data.reduce((total, blob) => (blob.length || blob.byteLength) + total, 0));
					case 'array': return size + data.reduce((total, arr) => total + this.getDataSize(arr, type.val, true), 0);
					case 'schemas': return size + data.length * type.bytes + data.reduce((total, data) => total + this.getDataSize(data[1], type.val[data[0]], true), 0);
					default: return size + data.reduce((total, obj) => total + this.getDataSize(obj, type, true), 0);
				}
			case 'schemas': return Buf.getVarIntSize(schema.values[data[0]]) + this.getDataSize(data[1], schema.val[data[0]]);
			default: // object
				const o = schema[PackBytes.objSchema];
				return o.bytes // covers bool, bits, float
					+ o.strings.reduce((total, str) => total + Buf.strTotalLength(PackBytes.get(data, str.field)), 0)
					+ o.blobs.reduce((total, blob) => { const length = blob.bytes || PackBytes.get(data, blob.field)[PackBytes.isNode ? 'length' : 'byteLength']; return total + length + Buf.getVarIntSize(length); }, 0)
					+ o.arrays.reduce((total, arr) => total + this.getDataSize(PackBytes.get(data, arr.field), PackBytes.get(schema, arr.field), true), 0);
					+ o.schemas.reduce((total, s) => total + this.getDataSize(PackBytes.get(data, s.field), PackBytes.get(schema, s.field), true), 0);
		}
	}
	writeSchema(schema, data, isChild) {
		switch (schema._type) {
			case 'bool': this.buf.writeUint(data, 1); break;
			case 'bits': this.buf.writeUint(data, schema.bytes); break;
			case 'float': this.buf.writeFloat(data, schema.bytes); break;
			case 'string': schema.bits ? this.buf.writeUint(schema.values[data], schema.bytes) : this.buf.writeString(data); break;
			case 'blob': this.buf.writeBlob(data, schema.bytes); break;
			case 'array': if (!schema._size && isChild) this.buf.writeVarInt(data.length); for (const item of data) this.writeSchema(schema.val, item, true); break;
			case 'schemas': this.buf.writeVarInt(schema.values[data[0]]); this.writeSchema(schema.val[data[0]], data[1], isChild); break;
			default: // object
				const o = schema[PackBytes.objSchema];
				if (o.int8.length) for (const ints of o.int8) this.writeInts(1, ints, data);
				if (o.int16.length) for (const ints of o.int16) this.writeInts(2, ints, data);
				if (o.int32.length) for (const ints of o.int32) this.writeInts(4, ints, data);
				if (o.floats.length) for (const float of o.floats) this.buf.writeFloat(PackBytes.get(data, float.field), float.bytes);
				if (o.strings.length) for (const str of o.strings) this.buf.writeString(PackBytes.get(data, str.field));
				if (o.blobs.length) for (const blob of o.blobs) this.buf.writeBlob(PackBytes.get(data, blob.field), blob.bytes);
				if (o.arrays.length) for (const arr of o.arrays) this.writeSchema(PackBytes.get(schema, arr.field), PackBytes.get(data, arr.field), true);
				if (o.schemas.length) for (const s of o.schemas) this.writeSchema(PackBytes.get(schema, s.field), PackBytes.get(data, s.field), true);
		}
	}
	readSchema(schema, isChild) {
		switch (schema._type) {
			case 'bool': return this.buf.readUint(1);
			case 'bits': return this.buf.readUint(schema.bytes);
			case 'float': return this.buf.readFloat(schema.bytes);
			case 'string': return schema.bits ? schema.index[this.buf.readUint(schema.bytes)] : this.buf.readString();
			case 'blob': return this.buf.readBlob(schema.bytes);
			case 'array': 
				const arr = [];
				let length = schema._size || (isChild && this.buf.readVarInt());
				if (isChild) while (length--) arr.push(this.readSchema(schema.val, true));
				else while (this.buf.hasMore) arr.push(this.readSchema(schema.val, true));
				return arr;
			case 'schemas':
				const name = schema.index[this.buf.readVarInt()];
				return [ name, this.readSchema(schema.val[name], isChild) ];
			default: // object
				const obj = {};
				const o = schema[PackBytes.objSchema];
				if (o.int8.length) for (const ints of o.int8) this.readInts(1, ints, obj);
				if (o.int16.length) for (const ints of o.int16) this.readInts(2, ints, obj);
				if (o.int32.length) for (const ints of o.int32) this.readInts(4, ints, obj);
				if (o.floats.length) for (const float of o.floats) PackBytes.set(obj, float.field, this.buf.readFloat(float.bytes));
				if (o.strings.length) for (const str of o.strings) PackBytes.set(obj, str.field, this.buf.readString());
				if (o.blobs.length) for (const blob of o.blobs) PackBytes.set(obj, blob.field, this.buf.readBlob(blob.bytes));
				if (o.arrays.length) for (const arr of o.arrays) PackBytes.set(obj, arr.field, this.readSchema(arr.val, true));
				if (o.schemas.length) for (const s of o.schemas) PackBytes.set(obj, s.field, this.readSchema(s.val.index[this.buf.readVarInt()], isChild));
				return obj;
		}
	}
	writeInts(bytes, ints, data) {
		let packed = 0;
		for (const int of ints) {
			packed <<= int.bits;
			packed |= PackBytes.get(data, int.field);
		}
		this.buf.writeUint(packed >>> 0, bytes);
	}
	readInts(bytes, ints, obj) {
		let packed = this.buf.readUint(bytes);
		if (ints.length > 1) for (let i = ints.length - 1; i >= 0; i--) {
			const val = ints[i].bool ? Boolean(packed & 1) : packed % (1 << ints[i].bits);
			PackBytes.set(obj, ints[i].field, ints[i].string ? ints[i].string.index[val] : val);
			packed >>>= ints[i].bits;
		} else PackBytes.set(obj, ints[0].field, ints[0].bool ? Boolean(packed) : packed);
	}
	static packInts(o) {
		o.ints.sort((a, b) => b.bits - a.bits);
		while (o.ints.length) {
			let ints32 = [], remaining = 32;
			for (let i = 0; i < o.ints.length; i++) {
				if (o.ints[i].bits <= remaining) {
					remaining -= o.ints[i].bits;
					ints32.push(...o.ints.splice(i--, 1));
					if (!remaining) break;
				}
			}
			(remaining < 16 ? o.int32 : remaining < 24 ? o.int16 : o.int8).push(ints32);
		}
		o.bytes = (o.int32.length * 4) + (o.int16.length * 2) + o.int8.length + o.floats.reduce((total, float) => total + float.bytes, 0);
	}
	static genMap(type, values) {
		type.index = {}; type.values = {};
		values.forEach((val, i) => { type.index[i] = val; type.values[val] = i; });
		type.bits = PackBytes.numberToBits(values.length - 1);
		type.bytes = Math.ceil(type.bits / 8);
	}
	static isNode = typeof window != 'object';
	static objSchema = Symbol('objSchema');
	static numberToBits(num) { return Math.ceil(Math.log2(num + 1)) || 1; }
	static newObjSchema() { return { ints: [], int8: [], int16: [], int32: [], strings: [], blobs: [], floats: [], arrays: [], schemas: [] }; }
	static get(obj, field) { return field.reduce?.((obj, field) => obj[field], obj) || obj[field]; }
	static set(obj, field, val) {
		if (Array.isArray(field)) field.reduce((obj, _field, i) => {
			if (i == field.length - 1) obj[_field] = val;
			else return obj[_field] ??= {};
		}, obj);
		else obj[field] = val;
	}
}

class Buf { // cross-platform buffer operations for Node.js and Web Browser
	constructor(buf, size) {
		this.buf = Buf.isNode ? buf instanceof ArrayBuffer && Buffer.from(buf) || buf || Buffer.allocUnsafe(size) : new DataView(buf?.buffer || buf || new ArrayBuffer(size));
		this.off = 0;
	}
	readString() {
		const length = this.readVarInt();
		const str = Buf.isNode ? this.buf.toString('utf8', this.off, this.off + length) : Buf.textDecoder.decode(new Uint8Array(this.buf.buffer, this.off, length));
		this.off += length;
		return str;
	}
	writeString(str) {
		if (!Buf.isNode) str = Buf.textEncoder.encode(str);
		const length = Buf.isNode ? Buffer.byteLength(str) : str.length;
		this.writeVarInt(length);
		Buf.isNode ? this.buf.write(str, this.off) : new Uint8Array(this.buf.buffer, this.off, length).set(str);
		this.off += length;
	}
	readBlob(bytes) {
		const length = bytes || this.readVarInt();
		const blob = Buf.isNode ? this.buf.subarray(this.off, this.off + length) : new Uint8Array(this.buf.buffer, this.off, length);
		this.off += length;
		return blob;
	}
	writeBlob(buf, bytes) {
		const length = bytes || (Buf.isNode? buf.length : buf.byteLength);
		if (!bytes) this.writeVarInt(length);
		Buf.isNode ? buf.copy(this.buf, this.off, 0, bytes) : new Uint8Array(this.buf.buffer, this.off, length).set(buf);
		this.off += length;
	}
	readUint(bytes) {
		const int = this.buf[(Buf.isNode ? { 1: 'readUint8', 2: 'readUint16BE', 4: 'readUint32BE' } : { 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' })[bytes]](this.off);
		this.off += bytes;
		return int;
	}
	writeUint(val, bytes) {
		Buf.isNode ? this.buf[({ 1: 'writeUint8', 2: 'writeUint16BE', 4: 'writeUint32BE' })[bytes]](val, this.off) : this.buf[({ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' })[bytes]](this.off, val);
		this.off += bytes;
	}
	readFloat(bytes) {
		const int = this.buf[(Buf.isNode ? { 4: 'readFloatBE', 8: 'readDoubleBE'} : { 4: 'getFloat32', 8: 'getFloat64' })[bytes]](this.off);
		this.off += bytes;
		return int;
	}
	writeFloat(val, bytes) {
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
	get hasMore() { return this.off < this.buf[Buf.isNode ? 'length' : 'byteLength']; }
	static getVarIntSize(int) { return int < 128 ? 1 : int < 16_384 ? 2 : 4; }
	static strByteLength(str) { if (Buf.isNode) return Buffer.byteLength(str); let s = str.length; for (let i = str.length - 1; i >= 0; i--) { const code = str.charCodeAt(i); if (code > 0x7f && code <= 0x7ff) s++; else if (code > 0x7ff && code <= 0xffff) s += 2; if (code >= 0xDC00 && code <= 0xDFFF) i--; } return s; }
	static strTotalLength(str) { const length = Buf.strByteLength(str); return length + Buf.getVarIntSize(length); }
	static textEncoder = !Buf.isNode && new TextEncoder();
	static textDecoder = !Buf.isNode && new TextDecoder();
	static isNode = typeof window != 'object';
}
