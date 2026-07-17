class Pack {
	constructor(schema) {
		this.schema = JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
		Pack.init(this.schema);
	}
	encode(data, bufferSize = 4096) {
		this.offset = 0;
		if (!this.encodeAB) this.setEncodeBuffer(new ArrayBuffer(bufferSize));
		this.encodeSchema(this.schema, data);
		return new Uint8Array(this.encodeAB, 0, this.offset);
	}
	decode(b) { // takes TypedArray or ArrayBuffer
		this.offset = 0;
		this.decodeDV = b.buffer ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b);
		this.decodeUA = b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);
		return this.decodeSchema(this.schema);
	}

	static types = {
		bool: {
			encode: function(schema, data) { this.writeUint(1, data); },
			decode: function(schema) { return Boolean(this.readUint(1)); },
			init: schema => {
				schema.bits = 1; // schemas with "bits" field get packed into 8, 16, or 32 bit spaces by packInts() if schema is child of object, skipping encode/decode fn
				schema.bool = true;
			},
		},
		bits: {
			encode: function(schema, data) { this.writeUint(schema.bytes, data); },
			decode: function(schema) { return this.readUint(schema.bytes); },
			init: schema => {
				if (!(schema.val >= 1 && schema.val <= 32)) throw TypeError(`bit size must be 1 to 32, got "${schema.val}"`);
				schema.bits = schema.val;
				schema.bytes = schema.bits > 16 ? 4 : schema.bits > 8 ? 2 : 1;
			},
		},
		int: {
			encode: function(schema, data) { this.writeInt(schema.bytes, data); },
			decode: function(schema) { return this.readInt(schema.bytes); },
			init: schema => {
				if (![ 8, 16, 32 ].includes(schema.val)) throw TypeError(`int must be 8, 16, or 32 bits, got "${schema.val}"`);
				schema.bytes = schema.val / 8;
			},
		},
		float: {
			encode: function(schema, data) { this.writeFloat(schema.bytes, data); },
			decode: function(schema) { return this.readFloat(schema.bytes); },
			init: schema => {
				if (![ 16, 32, 64 ].includes(schema.val)) throw TypeError(`float must be 16, 32, or 64 bits, got "${schema.val}"`);
				schema.bytes = schema.val / 8;
			},
		},
		varint: {
			encode: function(schema, data) { this.writeVarInt(data); },
			decode: function(schema) { return this.readVarInt(); },
		},
		string: {
			encode: function(schema, data) { schema.val ? this.writeUint(schema.map.bytes, schema.map.values[data]) : this.writeString(data); },
			decode: function(schema) { return schema.val ? schema.map.index[this.readUint(schema.map.bytes)] : this.readString(); },
			init: schema => schema.val && (schema.map = Pack.genMap(schema.val)),
		},
		blob: {
			encode: function(schema, data) { this.writeBlob(data, schema.val); },
			decode: function(schema) { return this.readBlob(schema.val); },
		},
		array: {
			encode: function(schema, data = []) {
				if (!schema.length) this.writeVarInt(data.length);
				if (schema.packSize) {
					const len = data.length - 1;
					var pack = 0;
					data.forEach((d, i) => {
						pack <<= schema.val.bits;
						pack += Pack.minmax(d, 0, Pack.maxInt[schema.val.bits]);
						if (!((i + 1) % schema.packSize) || i == len) {
							this.writeUint(schema.packBytes, pack);
							pack = 0;
						}
					});
				} else for (const d of data) this.encodeSchema(schema.val, d);
			},
			decode: function(schema) {
				const arr = [], length = schema.length || this.readVarInt();
				if (schema.packSize) {
					var pack, packArr = [];;
					for (let i = 0; i < length; i++) {
						if (!(i % schema.packSize)) {
							while (packArr.length) arr.push(packArr.pop());
							pack = this.readUint(schema.packBytes);
						}
						const val = pack % schema.itemSize;
						packArr.push(schema.val.bool ? Boolean(val) : val);
						pack >>>= schema.val.bits;
						if (!((i + 1) % schema.packSize)) {
							while (packArr.length) arr.push(packArr.pop());
						}
					}
					while (packArr.length) arr.push(packArr.pop());
				} else for (let i = 0; i < length; i++) arr.push(this.decodeSchema(schema.val));
				return arr;
			},
			init: schema => {
				if (!schema.val) throw TypeError(`array must have child type`);
				Pack.init(schema.val);
				if (schema.val.bits) {
					schema.packSize = Pack.arrayPackCount[schema.val.bits];
					schema.packBytes = Pack.bitsToBytes(schema.packSize * schema.val.bits);
					schema.itemSize = 2**schema.val.bits;
				}
			},
		},
		object: {
			encode: function(schema, data) {
				if (schema[Pack.pack]) {
					Pack.setData(schema, data);
					this.writePack(schema[Pack.pack]);
				}
				for (const field in schema) if (!schema[field].bits) this.encodeSchema(schema[field], data[field]);
			},
			decode: function(schema) {
				const obj = {}, p = schema[Pack.pack];
				if (p) this.readPack(p); // attaches decoded value to schema
				for (const field in schema) {
					const childSchema = schema[field];
					obj[field] = childSchema.data ?? this.decodeSchema(childSchema);
				}
				return obj;
			},
			init: (schema, parentPack) => {
				const p = parentPack || (schema[Pack.pack] = { ints: [], int8: [], int16: [], int32: [] });
				for (const field in schema) {
					const childSchema = schema[field];
					childSchema[Pack.fieldName] = field;
					Pack.init(childSchema, p);
					if (childSchema.bits) p.ints.push({ schema: childSchema });
				}
				if (!parentPack && p.ints.length) Pack.packInts(p, true);
			},
		},
		selectOne: {
			encode: function(schema, data) {
				for (const f in data) {
					this.writeUint(schema.map.bytes, schema.map.values[f]);
					this.encodeSchema(schema.val[f], data[f]);
					break;
				}
			},
			decode: function(schema) {
				const field = schema.map.index[this.readUint(schema.map.bytes)];
				return { [field]: this.decodeSchema(schema.val[field]) };
			},
			init: schema => {
				schema.map = Pack.genMap(Object.keys(schema.val));
				Object.values(schema.val).forEach(schema => Pack.init(schema));
			}
		},
		selectMany: {
			encode: function(schema, data) {
				let bit_field = 0, field_index = 0;
				for (const f in schema.val) {
					if (field_index == 32) { // max 32 fields per u32
						writeUint(4, bit_field);
						bit_field = field_index = 0;
					}
					if (data[f] !== undefined) bit_field += 1<<field_index; // active field
					field_index += 1;
				}
				this.writeUint(Pack.bitsToBytes(field_index), bit_field);
				for (const f in schema.val) if (data[f] !== undefined) this.encodeSchema(schema.val[f], data[f]);
			},
			decode: function(schema) {
				const obj = {}, field_count = schema.map.index.length;
				var field_index = 0;
				while (field_index < field_count) {
					const fields_in_group = Math.min(32, field_count - field_index); // process up to 32 fields per group
					const bit_field = this.readUint(Pack.bitsToBytes(fields_in_group));
					for (let index_in_group = 0; index_in_group < fields_in_group; index_in_group++) {
						if (bit_field & 1<<index_in_group) { // active field
							const f = schema.map.index[field_index];
							obj[f] = this.decodeSchema(schema.val[f]);
						}
						field_index++;
					}
				}
				return obj;
			},
			init: schema => {
				schema.map = Pack.genMap(Object.keys(schema.val));
				Object.values(schema.val).forEach(schema => Pack.init(schema));
			}
		},
		null: {
			encode: function() {},
			decode: function() { return null; },
		},
	};

	static type(schema) { return Pack.types[schema && (schema._type || 'object')]; }
	static init(schema, pack) { Pack.type(schema).init?.(schema, pack); }
	
	encodeSchema(schema, data) { Pack.type(schema).encode.call(this, schema, data); }
	decodeSchema(schema) { return Pack.type(schema).decode.call(this, schema); }

	writeInt(bytes, val) {
		this.checkSize(bytes);
		bytes == 1 ? this.encodeDV.setInt8(this.offset, Pack.minmax(val, -128, 127)) :
		bytes == 2 ? this.encodeDV.setInt16(this.offset, Pack.minmax(val, -32768, 32767)) :
			this.encodeDV.setInt32(this.offset, Pack.minmax(val, -2147483648, 2147483647));
		this.offset += bytes;
	}
	readInt(bytes) {
		const int =
			bytes == 1 ? this.decodeDV.getInt8(this.offset) :
			bytes == 2 ? this.decodeDV.getInt16(this.offset) :
				this.decodeDV.getInt32(this.offset);
		this.offset += bytes;
		return int;
	}
	writeUint(bytes, val) {
		this.checkSize(bytes);
		bytes == 1 ? this.encodeDV.setUint8(this.offset, val) :
		bytes == 2 ? this.encodeDV.setUint16(this.offset, val) :
			this.encodeDV.setUint32(this.offset, val);
		this.offset += bytes;
	}
	readUint(bytes) {
		const int =
			bytes == 1 ? this.decodeDV.getUint8(this.offset) :
			bytes == 2 ? this.decodeDV.getUint16(this.offset) :
				this.decodeDV.getUint32(this.offset);
		this.offset += bytes;
		return int;
	}
	writeFloat(bytes, val = 0) {
		this.checkSize(bytes);
		bytes == 2 ? this.encodeDV.setFloat16(this.offset, val) :
		bytes == 4 ? this.encodeDV.setFloat32(this.offset, val) :
			this.encodeDV.setFloat64(this.offset, val);
		this.offset += bytes;
	}
	readFloat(bytes) {
		const float =
			bytes == 2 ? this.decodeDV.getFloat16(this.offset) :
			bytes == 4 ? this.decodeDV.getFloat32(this.offset) :
				this.decodeDV.getFloat64(this.offset);
		this.offset += bytes;
		return float;
	}
	writeVarInt(int = 0) {
		if (int <= 0) this.writeUint(1, 0);
		else if (int <= 127) this.writeUint(1, int);
		else if (int <= 16_383) this.writeUint(1, 128 + (int & 63)), this.writeUint(1, int >>> 6);
		else {
			if (int > 1073741823) throw Error(`writeVarInt "${int}" exceeds max 1073741823`);
			this.writeUint(1, 192 + (int & 63)), this.writeUint(1, int >>> 6), this.writeUint(2, int >>> 14);
		}
	}
	readVarInt() {
		const val = this.readUint(1);
		if (val < 128) return val;
		if (val < 192) return (val - 128) + (this.readUint(1) << 6);
		return (val - 192) + (this.readUint(1) << 6) + (this.readUint(2) << 14);
	}
	writeString(str) {
		if (!str) return this.writeUint(0, 1);
		const uint8array = Pack.textEncoder.encode(str);
		this.writeVarInt(uint8array.length);
		this.checkSize(uint8array.length);
		this.encodeUA.set(uint8array, this.offset);
		this.offset += uint8array.length;
	}
	readString() {
		const length = this.readVarInt();
		const str = length ? Pack.textDecoder.decode(this.decodeUA.subarray(this.offset, this.offset + length)) : '';
		this.offset += length;
		return str;
	}
	writeBlob(blob, bytes) { // blob = Buffer, TypedArray, or ArrayBuffer
		if (!bytes && !blob?.byteLength) return this.writeUint(1, 0);
		if (!blob.buffer) blob = new Uint8Array(blob); // blob was ArrayBuffer
		else if (blob.BYTES_PER_ELEMENT != 1) blob = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
		const length = bytes ?? blob.byteLength;
		bytes ?? this.writeVarInt(length);
		this.checkSize(length);
		if (blob.byteLength < length) this.encodeUA.fill(0, this.offset + blob.byteLength, this.offset + length);
		else if (blob.byteLength > length) blob = new Uint8Array(blob.buffer, blob.byteOffset, length);
		this.encodeUA.set(blob, this.offset);
		this.offset += length;
	}
	readBlob(bytes) {
		const length = bytes == undefined ? this.readVarInt() : bytes;
		const blob = this.decodeUA.subarray(this.offset, this.offset + length);
		this.offset += length;
		return blob;
	}
	checkSize(bytes) {
		if (bytes + this.offset > this.encodeAB.byteLength) this.setEncodeBuffer(this.encodeAB.transfer((bytes + this.offset) * 2));
	}
	setEncodeBuffer(arrayBuffer) {
		this.encodeAB = arrayBuffer;
		this.encodeDV = new DataView(this.encodeAB); 
		this.encodeUA = new Uint8Array(this.encodeAB);
	}
	static packInts(o, sort) { // efficiently packs bits(1-32) fields into 32 / 16 / 8 bit spaces
		if (sort) o.ints.sort((a, b) => b.schema.bits - a.schema.bits);
		while (o.ints.length) {
			let pack = [], remaining = 32;
			for (let i = 0; i < o.ints.length; i++) {
				if (o.ints[i].schema.bits <= remaining) {
					remaining -= o.ints[i].schema.bits;
					pack.push(...o.ints.splice(i--, 1));
					if (!remaining) break;
				}
			}
			if (remaining < 8) o.int32.push(pack);
			else if (remaining < 16) { // try to fit into 16 + 8 space
				let ints16 = [], ints8 = [], remaining16 = 16, remaining8 = 8, fail;
				pack.forEach(int => {
					if (int.schema.bits <= remaining16) {
						remaining16 -= int.schema.bits;
						ints16.push(int);
					} else if (int.schema.bits <= remaining8) {
						remaining8 -= int.schema.bits;
						ints8.push(int);
					} else fail = true;
				});
				if (fail) o.int32.push(pack);
				else { o.int16.push(ints16); o.int8.push(ints8); }
			} else (remaining < 24 ? o.int16 : o.int8).push(pack);
		}
	}
	writePack(o) {
		if (o.int8.length) for (const ints of o.int8) this.writeInts(1, ints);
		if (o.int16.length) for (const ints of o.int16) this.writeInts(2, ints);
		if (o.int32.length) for (const ints of o.int32) this.writeInts(4, ints);
	}
	writeInts(bytes, ints) {
		let packed = 0;
		for (const int of ints) {
			const value = int.schema.map ? int.schema.map.values[int.schema.data] : int.schema.bool ? int.schema.data ? 1 : 0 : int.schema.data;
			if (!(value >= 0 && value <= Pack.maxInt[int.schema.bits])) throw RangeError(`field "${int.schema[Pack.fieldName]}" with value "${value}" out of range [ 0 - ${Pack.maxInt[int.schema.bits]} ]`);
			packed <<= int.schema.bits;
			packed |= value;
		}
		this.writeUint(bytes, packed >>> 0);
	}
	readPack(o, array) {
		if (o.int8.length) for (const ints of o.int8) this.readInts(1, ints, array);
		if (o.int16.length) for (const ints of o.int16) this.readInts(2, ints, array);
		if (o.int32.length) for (const ints of o.int32) this.readInts(4, ints, array);
		return array;
	}
	readInts(bytes, ints, array) {
		let packed = this.readUint(bytes);
		for (let i = ints.length - 1; i >= 0; i--) {
			const val = ints.length > 1 ? packed % (1 << ints[i].schema.bits) : packed;
			const data = ints[i].schema.bool ? Boolean(val) : ints[i].schema.map?.index[val] ?? val;
			if (array) array[ints[i].schema.index] = data;
			else ints[i].schema.data = data;
			packed >>>= ints[i].schema.bits;
		}
	}
	static setData(schema, data) {
		for (const field in schema) {
			if (schema[field].bits) schema[field].data = data[field] || 0;
			if (!schema[field]._type) Pack.setData(schema[field], data[field]); // no _type is object
		}
	}
	static genMap(values) {
		const bits = Pack.numberToBits(values.length - 1);
		return {
			bits,
			bytes: Math.ceil(bits / 8),
			index: values,
			values: values.reduce((obj, v, i) => (obj[v] = i, obj), {}),
		};
	}

	static pack = Symbol('pack');
	static fieldName = Symbol('fieldName');
	static textEncoder = new TextEncoder();
	static textDecoder = new TextDecoder();
	static arrayPackCount = [ 0, 8, 4, 5, 2, 3, 5, 0, 0, 3, 3 ];
	static maxInt = Array.from(Array(33), (x, i) => 2**i - 1);
	static bitsToBytes(bits) { return Math.ceil(bits / 8); }
	static numberToBits(num) { return Math.ceil(Math.log2(num + 1)) || 1; }
	static minmax(val, min, max) { return Math.min(max, Math.max(min, val)); }
}

const genType = _type => {
	const fn = (val, length) => ({ _type, val, length });
	fn.toJSON = () => ({ _type });
	fn._type = _type;
	return fn;
};
export default Object.keys(Pack.types).reduce((o, t) => (o[t] = genType(t), o), { Pack });
