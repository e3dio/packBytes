// Cross platform (Node.js / Web Browser) buffer api:
import { Buf } from './buf.mjs';

// Binary encoder and decoder from declared schemas:
export class PackBytes {
	constructor(schema) {
		this.schema = PackBytes.parse(schema);
		this.type(this.schema).init?.(this.schema);
	}
	encode(schema, data) {
		data = this.inputs(schema, data);
		this.buf = new Buf(this.estimateSize(data));
		this.type(this.schema).encode(this.schema, data);
		return this.sliceBuf();
	}
	decode(buf) {
		this.buf = new Buf(buf);
		return this.type(this.schema).decode(this.schema);
	}
	types = {
		bool: {
			encode: (schema, data = 0) => this.buf.writeUint(data, 1),
			decode: (schema) => Boolean(this.buf.readUint(1)),
			init: (schema) => schema.bits = 1,
		},
		bits: {
			encode: (schema, data = 0) => this.buf.writeUint(Math.max(0, Math.min(data, schema.max)), schema.bytes),
			decode: (schema) => this.buf.readUint(schema.bytes),
			init: (schema, objSchema) => {
				if (objSchema) {
					schema.bits = schema.val;
					schema.max = 2**schema.bits - 1;
				} else {
					schema.bytes = Math.ceil((schema.val) / 8);
					schema.max = 2**(schema.bytes * 8) - 1;
				}
			},
		},
		float: {
			encode: (schema, data = 0) => this.buf.writeFloat(data, schema.bytes),
			decode: (schema) => this.buf.readFloat(schema.bytes),
			init: (schema) => schema.bytes = schema.val / 8,
		},
		varint: {
			encode: (schema, data = 0) => this.buf.writeVarInt(data),
			decode: (schema) => this.buf.readVarInt(),
		},
		string: {
			encode: (schema, data = '') => schema.map ? this.buf.writeUint(schema.map.values[data], schema.map.bytes) : this.buf.writeString(data),
			decode: (schema) => schema.map ? schema.map.index[this.buf.readUint(schema.map.bytes)] : this.buf.readString(),
			init: (schema) => {
				if (schema.val) {
					schema.map = PackBytes.genMap(schema.val);
					schema.bits = schema.map.bits;
				}
			},
		},
		blob: {
			encode: (schema, data = PackBytes.defaultBlob) => this.buf.writeBlob(data, schema.val),
			decode: (schema) => this.buf.readBlob(schema.val),
		},
		objectid: {
			encode: (schema, data = PackBytes.defaultObjectID) => this.buf.writeBlob(data.id, 12),
			decode: (schema) => {
				const blob = this.buf.readBlob(12);
				if (Buf.isNode) return blob.toString('hex');
				let str = ''; for (let i = 0; i < blob.length; ++i) str += Buf.byteToHex[blob[i]];
				return str;
			},
		},
		uuid: {
			encode: (schema, data = PackBytes.defaultUUID) => this.buf.writeBlob(data.buffer, 16),
			decode: (schema) => this.buf.readBlob(16),
		},
		date: {
			encode: (schema, data = PackBytes.defaultDate) => this.buf.writeUint(Math.floor(data.getTime() / 1000), 4),
			decode: (schema) => new Date(this.buf.readUint(4) * 1000),
		},
		lonlat: {
			encode: (schema, data = PackBytes.defaultLonlat) => {
				this.buf.writeUint((data[0] + 180) * 1e7, 4);
				this.buf.writeUint((data[1] + 90) * 1e7, 4);
			},
			decode: (schema) => [ this.buf.readUint(4) / 1e7 - 180, this.buf.readUint(4) / 1e7 - 90 ],
		},
		array: {
			encode: (schema, data = []) => {
				if (!schema._size) this.buf.writeVarInt(data.length);
				for (const item of data) this.type(schema.val).encode(schema.val, item);
			},
			decode: (schema) => {
				const arr = [];
				const length = schema._size || this.buf.readVarInt();
				for (let i = length; i > 0; i--) arr.push(this.type(schema.val).decode(schema.val));
				return arr;
			},
			init: (schema) => this.type(schema.val).init?.(schema.val),
		},
		schemas: {
			encode: (schema, data) => {
				this.buf.writeVarInt(schema.map.values[data[0]]);
				const dataSchema = schema.val[data[0]];
				this.type(dataSchema).encode(dataSchema, data[1]);
			},
			decode: (schema) => {
				const name = schema.map.index[this.buf.readVarInt()];
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
					PackBytes.setData(schema, data);
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
	};
	static genMap(values) {
		const bits = PackBytes.numberToBits(values.length - 1);
		return {
			bits,
			bytes: Math.ceil(bits / 8),
			index: values,
			values: values.reduce((obj, v, i) => (obj[v] = i, obj), {})
		};
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
	};
	static setData(schema, data) {
		for (const field in schema) {
			const childSchema = schema[field];
			const childData = data[field];
			if (childSchema.bits) childSchema.data = childData;
			if (!childSchema._type) PackBytes.setData(childSchema, childData);
		}
	}
	writeInts(bytes, ints) {
		let packed = 0;
		for (const int of ints) {
			packed <<= int.bits;
			packed |= int.map ? int.map.values[int.data] : int.data;
		}
		this.buf.writeUint(packed >>> 0, bytes);
	};
	readInts(bytes, ints) {
		let packed = this.buf.readUint(bytes);
		if (ints.length > 1) for (let i = ints.length - 1; i >= 0; i--) {
			const val = packed % (1 << ints[i].bits);
			ints[i].decoded = ints[i].bool ? Boolean(val) : ints[i].map?.index[val] || val
			packed >>>= ints[i].bits;
		} else ints[0].decoded = ints[0].bool ? Boolean(packed) : ints[0].map?.index[packed] || packed;
	};
	estimateSize() {
		return 8000;
	}
	sliceBuf() { // non-copy sliced view
		return this.buf.off < this.buf.length ?
			Buf.isNode ? this.buf.buf.subarray(0, this.buf.off) : new Uint8Array(this.buf.buf.buffer, 0, this.buf.off)
			: this.buf.buf;
	}
	type(schema) { return this.types[schema._type || 'object']; }
	inputs(schema, data) { return this.schema._type == 'schemas' ? [ schema, data ] : schema; }
	static parse(schema) { return JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema)); }
	static numberToBits(num) { return Math.ceil(Math.log2(num + 1)) || 1; }
	static newObjSchema() { return ({ ints: [], int8: [], int16: [], int32: [] }); }
	static objSchema = Symbol('objSchema');
	static defaultUUID = { buffer: new Uint8Array(16) };
	static defaultObjectID = { id: new Uint8Array(12) };
	static defaultBlob = new Uint8Array(0);
	static defaultDate = new Date(0);
	static defaultLonlat = [ 0, 0 ];
};
