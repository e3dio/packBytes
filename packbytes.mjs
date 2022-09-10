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
		this.schema = JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
		this.scanSchema(this.schema);
	}
	encode(...data) {
		if (this.schema._type != 'schemas' || Array.isArray(data[0])) data = data[0];
		this.buf = new Buf(null, this.getDataSize(data, this.schema, true));
		this.writeSchema(this.schema, data, true);
		return this.buf.buf;
	}
	decode(buf) {
		this.buf = new Buf(buf);
		return this.readSchema(this.schema, true);
	}
	scanSchema(schema, o, parent) {
		if (!schema) return;
		switch (schema._type) {
			case 'bool': schema.bits = 1; schema.bool = true; o?.ints.push(schema); break;
			case 'bits': schema.bytes = Math.ceil((schema.bits = schema.val) / 8); o?.ints.push(schema); break;
			case 'float': schema.bytes = schema.val / 8; o?.floats.push(schema); break;
			case 'string': if (schema.val) { schema.map = PackBytes.genMap(schema.val); schema.bits = schema.map.bits; } o?.[schema.map ? 'ints' : 'strings'].push(schema); break;
			case 'blob': schema.bytes = schema.val; o?.blobs.push(schema); break;
			case 'array': this.scanSchema(schema.val); o?.arrays.push(schema); break;
			case 'schemas': schema.map = PackBytes.genMap(Object.keys(schema.val)); Object.values(schema.val).forEach(s => this.scanSchema(s)); o?.schemas.push(schema); break;
			default: // object
				if (!o) o = schema[PackBytes.objSchema] = PackBytes.newObjSchema();
				for (let field in schema) {
					const type = schema[field];
					if (type._type) type.field = parent ? parent.concat(field) : field;
					this.scanSchema(type, o, parent ? field : [ field ]);
				}
				if (!parent) PackBytes.packInts(o);
		}
	}
	getDataSize(data, schema, top) {
		if (!schema) return 0;
		switch (schema._type) {
			case 'bool': return 1;
			case 'bits': return schema.bytes;
			case 'float': return schema.bytes;
			case 'string': return schema.map?.bytes || Buf.strTotalLength(data);
			case 'blob': return schema.bytes || Buf.length(data) + (top ? 0 : Buf.getVarIntSize(Buf.length(data)));
			case 'array': 
				const type = schema.val;
				const size = schema._size || top ? 0 : Buf.getVarIntSize(data.length);
				switch (type._type) {
					case 'bool': return size + data.length;
					case 'bits': return size + data.length * type.bytes;
					case 'float': return size + data.length * type.bytes;
					case 'string': return size + (data.length * type.map?.bytes || data.reduce((total, str) => Buf.strTotalLength(str) + total, 0));
					case 'blob': return size + (data.length * type.bytes || data.reduce((total, blob) => Buf.getVarIntSize(Buf.length(blob)) + Buf.length(blob) + total, 0));
					case 'array': return size + data.reduce((total, arr) => total + this.getDataSize(arr, type), 0);
					case 'schemas': return size + data.length * type.map.bytes + data.reduce((total, data) => total + this.getDataSize(data[1], type.val[data[0]]), 0);
					default: return size + data.reduce((total, obj) => total + this.getDataSize(obj, type), 0);
				}
			case 'schemas': return schema.map.bytes + this.getDataSize(data[1], schema.val[data[0]], top);
			default: // object
				const o = schema[PackBytes.objSchema];
				return o.bytes // covers bool, bits, float
					+ o.strings.reduce((total, str) => total + Buf.strTotalLength(PackBytes.get(data, str.field)), 0)
					+ o.blobs.reduce((total, blob) => { const length = blob.bytes || Buf.length(PackBytes.get(data, blob.field)); return total + length + (blob.bytes ? 0 : Buf.getVarIntSize(length)); }, 0)
					+ o.arrays.reduce((total, arr) => total + this.getDataSize(PackBytes.get(data, arr.field), PackBytes.get(schema, arr.field)), 0)
					+ o.schemas.reduce((total, s) => total + this.getDataSize(PackBytes.get(data, s.field), PackBytes.get(schema, s.field)), 0);
		}
	}
	writeSchema(schema, data, top) {
		if (!schema) return;
		switch (schema._type) {
			case 'bool': this.buf.writeUint(data, 1); break;
			case 'bits': this.buf.writeUint(data, schema.bytes); break;
			case 'float': this.buf.writeFloat(data, schema.bytes); break;
			case 'string': schema.map ? this.buf.writeUint(schema.map.values[data], schema.map.bytes) : this.buf.writeString(data); break;
			case 'blob': this.buf.writeBlob(data, schema.bytes, top); break;
			case 'array': if (!schema._size && !top) this.buf.writeVarInt(data.length); for (const item of data) this.writeSchema(schema.val, item); break;
			case 'schemas': this.buf.writeVarInt(schema.map.values[data[0]]); this.writeSchema(schema.val[data[0]], data[1], top); break;
			default: // object
				const o = schema[PackBytes.objSchema];
				if (o.int8.length) for (const ints of o.int8) this.writeInts(1, ints, data);
				if (o.int16.length) for (const ints of o.int16) this.writeInts(2, ints, data);
				if (o.int32.length) for (const ints of o.int32) this.writeInts(4, ints, data);
				if (o.floats.length) for (const float of o.floats) this.buf.writeFloat(PackBytes.get(data, float.field), float.bytes);
				if (o.strings.length) for (const str of o.strings) this.buf.writeString(PackBytes.get(data, str.field));
				if (o.blobs.length) for (const blob of o.blobs) this.buf.writeBlob(PackBytes.get(data, blob.field), blob.bytes);
				if (o.arrays.length) for (const arr of o.arrays) this.writeSchema(PackBytes.get(schema, arr.field), PackBytes.get(data, arr.field));
				if (o.schemas.length) for (const s of o.schemas) this.writeSchema(PackBytes.get(schema, s.field), PackBytes.get(data, s.field));
		}
	}
	readSchema(schema, top) {
		if (!schema) return null;
		switch (schema._type) {
			case 'bool': return Boolean(this.buf.readUint(1));
			case 'bits': return this.buf.readUint(schema.bytes);
			case 'float': return this.buf.readFloat(schema.bytes);
			case 'string': return schema.map ? schema.map.index[this.buf.readUint(schema.map.bytes)] : this.buf.readString();
			case 'blob': return this.buf.readBlob(schema.bytes, top);
			case 'array': 
				const arr = [];
				let length = schema._size || (!top && this.buf.readVarInt());
				if (length) while (length--) arr.push(this.readSchema(schema.val));
				else while (this.buf.hasMore) arr.push(this.readSchema(schema.val));
				return arr;
			case 'schemas':
				const name = schema.map.index[this.buf.readVarInt()];
				return [ name, this.readSchema(schema.val[name], top) ];
			default: // object
				const obj = {};
				const o = schema[PackBytes.objSchema];
				if (o.int8.length) for (const ints of o.int8) this.readInts(1, ints, obj);
				if (o.int16.length) for (const ints of o.int16) this.readInts(2, ints, obj);
				if (o.int32.length) for (const ints of o.int32) this.readInts(4, ints, obj);
				if (o.floats.length) for (const float of o.floats) PackBytes.set(obj, float.field, this.buf.readFloat(float.bytes));
				if (o.strings.length) for (const str of o.strings) PackBytes.set(obj, str.field, this.buf.readString());
				if (o.blobs.length) for (const blob of o.blobs) PackBytes.set(obj, blob.field, this.buf.readBlob(blob.bytes));
				if (o.arrays.length) for (const arr of o.arrays) PackBytes.set(obj, arr.field, this.readSchema(arr));
				if (o.schemas.length) for (const s of o.schemas) { const name = s.map.index[this.buf.readVarInt()]; PackBytes.set(obj, s.field, [ name, this.readSchema(s.val[name]) ]); };
				return obj;
		}
	}
	writeInts(bytes, ints, data) {
		let packed = 0;
		for (const int of ints) {
			packed <<= int.bits;
			packed |= int.map ? int.map.values[PackBytes.get(data, int.field)] : PackBytes.get(data, int.field);
		}
		this.buf.writeUint(packed >>> 0, bytes);
	}
	readInts(bytes, ints, obj) {
		let packed = this.buf.readUint(bytes);
		if (ints.length > 1) for (let i = ints.length - 1; i >= 0; i--) {
			const val = packed % (1 << ints[i].bits);
			PackBytes.set(obj, ints[i].field, ints[i].bool ? Boolean(val) : ints[i].map?.index[val] || val);
			packed >>>= ints[i].bits;
		} else PackBytes.set(obj, ints[0].field, ints[0].bool ? Boolean(packed) : ints[0].map?.index[packed] || packed);
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
	static genMap(values) {
		const bits = PackBytes.numberToBits(values.length - 1);
		return {
			bits,
			bytes: Math.ceil(bits / 8),
			index: values.reduce((obj, v, i) => (obj[i] = v, obj), {}),
			values: values.reduce((obj, v, i) => (obj[v] = i, obj), {})
		};
	}
	static isNode = typeof window != 'object';
	static objSchema = Symbol('objSchema');
	static newObjSchema() { return { ints: [], int8: [], int16: [], int32: [], strings: [], blobs: [], floats: [], arrays: [], schemas: [] }; }
	static numberToBits(num) { return Math.ceil(Math.log2(num + 1)) || 1; }
	static get(obj, field) { return field.reduce?.((obj, field) => obj[field], obj) || obj[field]; }
	static set(obj, field, val) {
		if (Array.isArray(field)) field.reduce((obj, _field, i) => {
			if (i == field.length - 1) obj[_field] = val;
			else return obj[_field] ??= {};
		}, obj);
		else obj[field] = val;
	}
}

export class Buf { // cross-platform buffer operations for Node.js and Web Browser
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
	readBlob(bytes, full) {
		const length = bytes || (full && this.length) || this.readVarInt();
		const blob = Buf.isNode ? this.buf.subarray(this.off, this.off + length) : new Uint8Array(this.buf.buffer, this.off, length);
		this.off += length;
		return blob;
	}
	writeBlob(buf, bytes, full) {
		const length = bytes || Buf.length(buf);
		if (!bytes && !full) this.writeVarInt(length);
		Buf.isNode ? buf.copy(this.buf, this.off, 0, length) : new Uint8Array(this.buf.buffer, this.off, length).set(buf);
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
	get length() { return Buf.isNode ? this.buf.length : this.buf.byteLength; }
	get hasMore() { return this.off < this.length; }
	static getVarIntSize(int) { return int < 128 ? 1 : int < 16_384 ? 2 : 4; }
	static strByteLength(str) { if (Buf.isNode) return Buffer.byteLength(str); let s = str.length; for (let i = str.length - 1; i >= 0; i--) { const code = str.charCodeAt(i); if (code > 0x7f && code <= 0x7ff) s++; else if (code > 0x7ff && code <= 0xffff) s += 2; if (code >= 0xDC00 && code <= 0xDFFF) i--; } return s; }
	static strTotalLength(str) { const length = Buf.strByteLength(str); return length + Buf.getVarIntSize(length); }
	static length(buf) { return Buf.isNode ? buf.length : buf.byteLength; }
	static isNode = typeof window != 'object';
	static textEncoder = !Buf.isNode && new TextEncoder();
	static textDecoder = !Buf.isNode && new TextDecoder();
}
