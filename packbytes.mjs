export class PackBytes {
	constructor(schema) {
		this.schema = PackBytes.parse(schema);
		this.type(this.schema).init?.(this.schema);
	}
	encode = (schema, data) => {
		data = this.inputs(schema, data);
		this.offset = 0;
		this.dataview = new DataView(new ArrayBuffer(this.estimateSize(data)));
		this.type(this.schema).encode(this.schema, data);
		return this.sliceBuffer();
	}
	decode = (buf) => {
		this.offset = 0;
		this.dataview = new DataView(buf.buffer || buf);
		return this.type(this.schema).decode(this.schema);
	}
	types = {
		bool: {
			encode: (schema, data = 0) => this.writeUint(data, 1),
			decode: (schema) => Boolean(this.readUint(1)),
			init: (schema) => {
				schema.bits = 1;
				schema.bool = true;
			},
		},
		bits: {
			encode: (schema, data = 0) => this.writeUint(Math.max(0, Math.min(data, schema.max)), schema.bytes),
			decode: (schema) => this.readUint(schema.bytes),
			init: (schema, objSchema) => {
				if (objSchema) schema.bits = schema.val;
				schema.bytes = Math.ceil((schema.val) / 8);
				schema.max = 2**(schema.bytes * 8) - 1;
			},
		},
		float: {
			encode: (schema, data = 0) => this.writeFloat(data, schema.bytes),
			decode: (schema) => this.readFloat(schema.bytes),
			init: (schema) => schema.bytes = schema.val / 8,
		},
		varint: {
			encode: (schema, data = 0) => this.writeVarInt(data),
			decode: (schema) => this.readVarInt(),
		},
		string: {
			encode: (schema, data = '') => schema.map ? this.writeUint(schema.map.values[data], schema.map.bytes) : this.writeString(data),
			decode: (schema) => schema.map ? schema.map.index[this.readUint(schema.map.bytes)] : this.readString(),
			init: (schema) => {
				if (schema.val) {
					schema.map = PackBytes.genMap(schema.val);
					schema.bits = schema.map.bits;
				}
			},
		},
		blob: {
			encode: (schema, data = PackBytes.defaultBlob) => this.writeBlob(data, schema.val),
			decode: (schema) => this.readBlob(schema.val),
		},
		objectid: {
			encode: (schema, data = PackBytes.defaultObjectID) => this.writeBlob(data.id, 12),
			decode: (schema) => PackBytes.uint8arrayToHex(this.readBlob(12)),
		},
		uuid: {
			encode: (schema, data = PackBytes.defaultUUID) => this.writeBlob(data.buffer, 16),
			decode: (schema) => this.readBlob(16),
		},
		date: {
			encode: (schema, data = PackBytes.defaultDate) => {
				const seconds = Math.floor(data.getTime() / 1000);
				if (data < 0 || seconds > 4_294_967_295) throw Error(`date ${date} outside range ${new Date(0)} - ${new Date(4294967295000)}`);
				this.writeUint(seconds, 4);
			},
			decode: (schema) => new Date(this.readUint(4) * 1000),
		},
		lonlat: {
			encode: (schema, data = PackBytes.defaultLonlat) => {
				this.writeUint((data[0] + 180) * 1e7, 4);
				this.writeUint((data[1] + 90) * 1e7, 4);
			},
			decode: (schema) => [ this.readUint(4) / 1e7 - 180, this.readUint(4) / 1e7 - 90 ],
		},
		array: {
			encode: (schema, data = []) => {
				if (!schema._size) this.writeVarInt(data.length);
				for (const item of data) this.type(schema.val).encode(schema.val, item);
			},
			decode: (schema) => {
				const arr = [];
				const length = schema._size || this.readVarInt();
				for (let i = length; i > 0; i--) {
					const x = this.type(schema.val).decode(schema.val)
					arr.push(x);
				}
				return arr;
			},
			init: (schema) => this.type(schema.val).init?.(schema.val),
		},
		schemas: {
			encode: (schema, data) => {
				const index = schema.map.values[data[0]];
				if (index === undefined) throw Error(`Packbytes: schema "${data[0]}" not found in ${JSON.stringify(schema.map.index)}`);
				this.writeVarInt(index);
				const dataSchema = schema.val[data[0]];
				this.type(dataSchema).encode(dataSchema, data[1]);
			},
			decode: (schema) => {
				const name = schema.map.index[this.readVarInt()];
				const dataSchema = schema.val[name];
				return [ name, this.type(dataSchema).decode(dataSchema) ];
			},
			init: (schema) => {
				schema.map = PackBytes.genMap(Object.keys(schema.val));
				Object.values(schema.val).forEach(schema => this.type(schema).init?.(schema));
			}
		},
		object: {
			encode: (schema, data) => {
				const o = schema[PackBytes.objSchema];
				if (o) {
					PackBytes.setData(schema, data); // attaches bits data to schema
					if (o.int8.length) for (const ints of o.int8) this.writeInts(1, ints);
					if (o.int16.length) for (const ints of o.int16) this.writeInts(2, ints);
					if (o.int32.length) for (const ints of o.int32) this.writeInts(4, ints);
				}
				for (const field in schema) {
					const childSchema = schema[field];
					const childData = data[field];
					if (!childSchema.bits) this.type(childSchema).encode(childSchema, childData);
				}
			},
			decode: (schema) => {
				const obj = {}, o = schema[PackBytes.objSchema];
				if (o) {
					if (o.int8.length) for (const ints of o.int8) this.readInts(1, ints);
					if (o.int16.length) for (const ints of o.int16) this.readInts(2, ints);
					if (o.int32.length) for (const ints of o.int32) this.readInts(4, ints);
				}
				for (const field in schema) {
					const childSchema = schema[field];
					obj[field] = childSchema.decoded ?? this.type(childSchema).decode(childSchema);
				}
				return obj;
			},
			init: (schema, objSchema) => {
				const _objSchema = objSchema || (schema[PackBytes.objSchema] = PackBytes.newObjSchema());
				for (const field in schema) {
					const childSchema = schema[field];
					this.type(childSchema).init?.(childSchema, _objSchema);
					if (childSchema.bits) _objSchema.ints.push(childSchema);
				}
				if (!objSchema && _objSchema.ints.length) PackBytes.packInts(_objSchema);
			},
		},
		null: { encode: () => {}, decode: () => null },
	}
	static genMap(values) {
		const bits = PackBytes.numberToBits(values.length - 1);
		const z = {
			bits,
			bytes: Math.ceil(bits / 8),
			index: values,
			values: values.reduce((obj, v, i) => (obj[v] = i, obj), {})
		}
		return z;
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
	}
	static setData(schema, data) {
		for (const field in schema) {
			const childSchema = schema[field];
			const childData = data[field];
			if (childSchema.bits) childSchema.data = childData; // attaches data to schema
			if (!childSchema._type) {
				if (childData === undefined) throw Error(`Packbytes: no data for field "${field}"`);
				PackBytes.setData(childSchema, childData);
			}
		}
	}
	writeInts(bytes, ints) {
		let packed = 0;
		for (const int of ints) {
			packed <<= int.bits;
			packed |= int.map ? int.map.values[int.data] : int.data;
		}
		this.writeUint(packed >>> 0, bytes);
	};
	readInts(bytes, ints) {
		let packed = this.readUint(bytes);
		if (ints.length > 1) for (let i = ints.length - 1; i >= 0; i--) {
			const val = packed % (1 << ints[i].bits);
			ints[i].decoded = ints[i].bool ? Boolean(val) : ints[i].map?.index[val] ?? val;
			packed >>>= ints[i].bits;
		} else ints[0].decoded = ints[0].bool ? Boolean(packed) : ints[0].map?.index[packed] ?? packed;
	}
	estimateSize() {
		return 8000;
	}
	sliceBuffer() { // non-copy sliced view
		return this.offset < this.dataview.byteLength ? new Uint8Array(this.dataview.buffer, 0, this.offset) : this.dataview;
	}
	readString() {
		const length = this.readVarInt();
		const str = length ? PackBytes.textDecoder.decode(new Uint8Array(this.dataview.buffer, this.offset, length)) : '';
		this.offset += length;
		return str;
	}
	writeString(str) {
		const uint8array = PackBytes.textEncoder.encode(str);
		this.writeVarInt(uint8array.length);
		this.checkSize(uint8array.length);
		new Uint8Array(this.dataview.buffer, this.offset, uint8array.length).set(uint8array);
		this.offset += uint8array.length;
	}
	readBlob(bytes) {
		const length = bytes || this.readVarInt();
		const blob = new Uint8Array(this.dataview.buffer, this.offset, length);
		this.offset += length;
		return blob;
	}
	writeBlob(buf, bytes) {
		const length = bytes || buf.byteLength;
		if (bytes) {
			if (buf.byteLength > bytes) buf = buf.subarray(0, bytes); // zero copy sliced view
			else if (buf.byteLength < bytes) { // fill zero in case base buffer is not zero filled
				const newBuf = new Uint8Array(bytes);
				newBuf.set(buf);
				buf = newBuf;
			}
		} else this.writeVarInt(length);
		this.checkSize(length);
		new Uint8Array(this.dataview.buffer, this.offset, length).set(buf);
		this.offset += length;
	}
	readUint(bytes) {
		var int = this.dataview[({ 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' })[bytes]](this.offset);
		this.offset += bytes;
		return int;
	}
	writeUint(val, bytes) {
		this.checkSize(bytes);
		this.dataview[({ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' })[bytes]](this.offset, val);
		this.offset += bytes;
	}
	readFloat(bytes) {
		const float = this.dataview[({ 4: 'getFloat32', 8: 'getFloat64' })[bytes]](this.offset);
		this.offset += bytes;
		return float;
	}
	writeFloat(val, bytes) {
		this.checkSize(bytes);
		this.dataview[({ 4: 'setFloat32', 8: 'setFloat64'})[bytes]](this.offset, val);
		this.offset += bytes;
	}
	readVarInt() {
		let val = this.readUint(1);
		if (val < 128) return val;
		this.offset--; val = this.readUint(2);
		if (!(val & 0b1000_0000)) return ((val & 0b111_1111_0000_0000) >> 1) | (val & 0b111_1111);
		this.offset -= 2; val = this.readUint(4);
		return ((val & 0b111_1111_0000_0000_0000_0000_0000_0000) >> 1) | (val & 0b111_1111_1111_1111_1111_1111);
	}
	writeVarInt(int) {
		if (int < 128) return this.writeUint(int, 1);
		if (int < 16_384) return this.writeUint(((int & 0b11_1111_1000_0000) << 1) | (int & 0b111_1111) | 0b1000_0000_0000_0000, 2);
		if (int < 1_073_741_824) return this.writeUint(((int & 0b11_1111_1000_0000_0000_0000_0000_0000) << 1) | (int & 0b111_1111_1111_1111_1111_1111) | 0b1000_0000_1000_0000_0000_0000_0000_0000, 4);
		throw Error(`varInt max 1,073,741,823 exceeded: ${int}`);
	}
	checkSize(bytes) {
		//console.log('checkSize',bytes,this.offset, this.dataview.byteLength)
		if (bytes + this.offset > this.dataview.byteLength) {
			console.log('RESIZE BUFFER', bytes, this.offset, this.dataview.byteLength);
			this.dataview = new DataView(this.dataview.buffer.transfer(this.dataview.byteLength * 2));
		}
	}
	type(schema) { return this.types[schema ? schema._type || 'object' : 'null']; }
	inputs(schema, data) { return this.schema._type == 'schemas' ? [ schema, data ] : schema; }
	static parse(schema) { return JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema)); }
	static numberToBits(num) { return Math.ceil(Math.log2(num + 1)) || 1; }
	static newObjSchema() { return ({ ints: [], int8: [], int16: [], int32: [] }); }
	static getVarIntSize(int) { return int < 128 ? 1 : int < 16_384 ? 2 : 4; }
	static strByteLength(str = '') { let s = str.length; for (let i = str.length - 1; i >= 0; i--) { const code = str.charCodeAt(i); if (code > 0x7f && code <= 0x7ff) s++; else if (code > 0x7ff && code <= 0xffff) s += 2; if (code >= 0xDC00 && code <= 0xDFFF) i--; } return s; }
	static strTotalLength(str = '') { const length = PackBytes.strByteLength(str); return length + PackBytes.getVarIntSize(length); }
	static uint8arrayToHex(uint8) { return Array.from(uint8).map(a => PackBytes.byteToHex[a]).join(''); }
	static byteToHex = Array.from(Array(256)).map((a, i) => i.toString(16).padStart(2, '0'));
	static objSchema = Symbol('objSchema');
	static defaultBlob = new Uint8Array(0);
	static defaultObjectID = { id: new Uint8Array(12) };
	static defaultUUID = { buffer: new Uint8Array(16) };
	static defaultDate = new Date(0);
	static defaultLonlat = [ 0, 0 ];
	static textEncoder = new TextEncoder();
	static textDecoder = new TextDecoder();
	static size(s) { this._size = s; return this; }
	static genType(_type) {
		const fn = val => ({ _type, val, size: PackBytes.size });
		fn.toJSON = () => ({ _type });
		fn._type = _type;
		return fn;
	}
}

export const [ bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas ] =
	[ 'bool', 'bits', 'float', 'varint', 'string', 'blob', 'objectid', 'uuid', 'date', 'lonlat', 'array', 'schemas' ].map(PackBytes.genType);
