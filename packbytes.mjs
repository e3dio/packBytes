export const PackBytes = (schema, bufferSize = 4096) => {
	initialize(schema = parse(schema));
	const buf = setEncodeBuffer(new ArrayBuffer(bufferSize));
	return {
		encode: data => {
			buf.offset = 0;
			encodeSchema(buf, schema, data);
			return new Uint8Array(buf.encodeAB, 0, buf.offset);
		},
		decode: buffer => decodeSchema(decodeBuffer(buffer), schema),
	};
};

const types = {
	bool: {
		encode: (buf, schema, data = 0) => writeUint(buf, data, 1),
		decode: (buf, schema) => Boolean(readUint(buf, 1)),
		init: schema => {
			schema.bits = 1; // schemas with "bits" field get packed into 32 bit spaces by packInts() if schema is child of object, skipping encode/decode fn
			schema.bool = true;
		},
	},
	bits: {
		encode: (buf, schema, data = 0) => writeUint(buf, data, schema.bytes),
		decode: (buf, schema) => readUint(buf, schema.bytes),
		init: schema => {
			if (!(schema.val >= 1 && schema.val <= 32)) throw TypeError(`bit size must be 1 to 32, received "${schema.val}"`);
			schema.bits = schema.val;
			schema.bytes = schema.bits > 16 ? 4 : schema.bits > 8 ? 2 : 1;
		},
	},
	float: {
		encode: (buf, schema, data = 0) => writeFloat(buf, data, schema.bytes),
		decode: (buf, schema) => readFloat(buf, schema.bytes),
		init: schema => {
			if (schema.val != 16 && schema.val != 32 && schema.val != 64) throw TypeError(`float must be 16, 32, or 64 bits, received "${schema.val}"`);
			schema.bytes = schema.val / 8;
		},
	},
	varint: {
		encode: (buf, schema, data = 0) => writeVarInt(buf, data),
		decode: (buf, schema) => readVarInt(buf),
	},
	string: {
		encode: (buf, schema, data = '') => {
			if (schema.map) {
				const int = schema.map.values[data] || 0;
				writeUint(buf, int, schema.map.bytes) 
			} else writeString(buf, data);
		},
		decode: (buf, schema) => schema.map ? schema.map.index[readUint(buf, schema.map.bytes)] : readString(buf),
		init: schema => {
			if (schema.val) {
				if (schema.val[0] != '') schema.val.unshift('');
				schema.map = genMap(schema.val);
				schema.bits = schema.map.bits;
			}
		},
	},
	blob: {
		encode: (buf, schema, data = defaultBlob) => writeBlob(buf, data, schema.val),
		decode: (buf, schema) => readBlob(buf, schema.val),
	},
	date: {
		encode: (buf, schema, data = defaultDate) => writeFloat(buf, data.getTime(), schema.val == 32 ? 4 : 8),
		decode: (buf, schema) => new Date(readFloat(buf, schema.val == 32 ? 4 : 8)),
	},
	array: {
		encode: (buf, schema, data = []) => {
			if (!schema._size) writeVarInt(buf, data.length);
			if (schema.packSizeBits) {
				data.forEach((d, i) => {
					pack <<= schema.packSizeBits;
					pack += d;
					if (!(i % schema.packSize) && i) {
						writeUint(buf, pack, schema.packSizeBytes);
						pack = 0;
					}
				});
				if (pack) writeUint(buf, pack, schema.packSizeBytes);
			} else for (const d of data) encodeSchema(buf, schema.val, d);
		},
		decode: (buf, schema) => {
			const arr = [], length = schema._size || readVarInt(buf);
			if (schema.packSizeBits) {
				var pack;
				for (let i = 0; i < length; i++) {
					if (!(i % schema.packSize)) {
						pack = readUint(buf, schema.packSizeBits);
					}
					arr.push(pack % schema.packSizeBits);
					pack >>>= schema.packSizeBits;
				}
			} else for (let i = 0; i < length; i++) arr.push(decodeSchema(buf, schema.val));
			return arr;
		},
		init: schema => {
			schema.packSizeBits = arrayPackSizes[schema.val.bits];
			schema.packSizeBytes = bitsToBytes(schema.packSizeBits);
			initialize(schema.val);
		},
	},
	object: {
		encode: (buf, schema, data) => {
			if (schema[pack]) {
				setData(schema, data);
				writePack(buf, schema[pack]);
			}
			for (const field in schema) if (!schema[field].bits) encodeSchema(buf, schema[field], data[field]);
		},
		decode: (buf, schema) => {
			const obj = {}, p = schema[pack];
			if (p) readPack(buf, p); // attaches decoded value to schema
			for (const field in schema) {
				const childSchema = schema[field];
				obj[field] = childSchema.data ?? decodeSchema(buf, childSchema);
			}
			return obj;
		},
		init: (schema, parentPack) => {
			const p = parentPack || (schema[pack] = newPack());
			for (const field in schema) {
				const childSchema = schema[field];
				childSchema[fieldName] = field;
				initialize(childSchema, p);
				if (childSchema.bits) p.ints.push({ schema: childSchema });
			}
			if (!parentPack && p.ints.length) packInts(p, true);
		},
	},
	select: {
		encode: (buf, schema, data) => {
			for (const f in data) {
				writeUint(buf, schema.map.values[f], schema.map.bytes);
				encodeSchema(buf, schema.val[f], data[f]);
				break;
			}
		},
		decode: (buf, schema) => {
			const field = schema.map.index[readUint(buf, schema.map.bytes)];
			return { [field]: decodeSchema(buf, schema.val[field]) };
		},
		init: schema => {
			schema.map = genMap(Object.keys(schema.val));
			Object.values(schema.val).forEach(schema => initialize(schema));
		}
	},
	union: {
		encode: (buf, schema, data) => {
			let field_bits = 0, field_count = 0;
			for (const f in schema.val) {
				if (field_count == 32) { // max 32 fields per u32
					writeUint(buf, field_bits, 4);
					field_bits = field_count = 0;
				}
				if (data[f] !== undefined) field_bits += 1<<field_count; // active field
				field_count += 1;
			}
			writeUint(buf, field_bits, bitsToBytes(field_count));
			for (const f in schema.val) if (data[f] !== undefined) encodeSchema(buf, schema.val[f], data[f]);
		},
		decode: (buf, schema) => {
			const obj = {};
			const total = schema.map.index.length;
			var i = 0;
			while (i < total) {
				var int = Math.min(32, total - i);
				var field_bits = readUint(buf, bitsToBytes(int));
				while (int > 0) {
					if (field_bits & 1) obj[schema.map.index[i]] = decodeSchema(buf, schema.val[schema.map.index[i]]);
					field_bits >>>= 1;
					int--;
					i++;
				}
			}
			return obj;
		},
		init: schema => {
			schema.map = genMap(Object.keys(schema.val));
			Object.values(schema.val).forEach(schema => initialize(schema));
		}
	},
	null: {
		encode: () => {},
		decode: () => null,
	},
};

const type = schema => types[typeName(schema)];
const typeName = schema => schema ? schema._type || 'object' : schema;
const parse = schema => JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
const initialize = (schema, pack) => type(schema).init?.(schema, pack);
const encodeSchema = (buf, schema, data) => type(schema).encode(buf, schema, data);
const decodeSchema = (buf, schema) => type(schema).decode(buf, schema);
const setEncodeBuffer = (arrayBuffer, buf = {}) => {
	buf.encodeAB = arrayBuffer;
	buf.encodeDV = new DataView(arrayBuffer); 
	buf.encodeUA = new Uint8Array(arrayBuffer);
	return buf;
};
const decodeBuffer = b => ({ // b = Buffer, TypedArray, or ArrayBuffer
	decodeDV: b.buffer ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b),
	decodeUA: b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b),
	offset: 0,
});

const writeUint = (buf, val, bytes) => {
	checkSize(buf, bytes);
	bytes == 1 ? buf.encodeDV.setUint8(buf.offset, val) :
	bytes == 2 ? buf.encodeDV.setUint16(buf.offset, val) :
		buf.encodeDV.setUint32(buf.offset, val);
	buf.offset += bytes;
};
const readUint = (buf, bytes) => {
	const int =
		bytes == 1 ? buf.decodeDV.getUint8(buf.offset) :
		bytes == 2 ? buf.decodeDV.getUint16(buf.offset) :
			buf.decodeDV.getUint32(buf.offset);
	buf.offset += bytes;
	return int;
};
const writeFloat = (buf, val, bytes) => {
	checkSize(buf, bytes);
	bytes == 2 ? buf.encodeDV.setFloat16(buf.offset, val) :
	bytes == 4 ? buf.encodeDV.setFloat32(buf.offset, val) :
		buf.encodeDV.setFloat64(buf.offset, val);
	buf.offset += bytes;
};
const readFloat = (buf, bytes) => {
	const float =
		bytes == 2 ? buf.decodeDV.getFloat16(buf.offset) :
		bytes == 4 ? buf.decodeDV.getFloat32(buf.offset) :
			buf.decodeDV.getFloat64(buf.offset);
	buf.offset += bytes;
	return float;
};
const writeVarInt = (buf, int) => {
	if (int < 0) return writeUint(buf, 0, 1);
	if (int <= 127) return writeUint(buf, int, 1);
	if (int <= 16_383) return writeUint(buf, ((int & 0b11_1111_1000_0000) << 1) | (int & 0b111_1111) | 0b1000_0000_0000_0000, 2);
	if (int <= 1_073_741_823) return writeUint(buf, ((int & 0b11_1111_1000_0000_0000_0000_0000_0000) << 1) | (int & 0b111_1111_1111_1111_1111_1111) | 0b1000_0000_1000_0000_0000_0000_0000_0000, 4);
	throw RangeError(`varInt max 1,073,741,823 exceeded: "${int}"`);
};
const readVarInt = buf => {
	let val = readUint(buf, 1);
	if (val < 128) return val;
	buf.offset--; val = readUint(buf, 2);
	if (!(val & 0b1000_0000)) return ((val & 0b111_1111_0000_0000) >> 1) | (val & 0b111_1111);
	buf.offset -= 2; val = readUint(buf, 4);
	return ((val & 0b111_1111_0000_0000_0000_0000_0000_0000) >> 1) | (val & 0b111_1111_1111_1111_1111_1111);
};
const writeString = (buf, str) => {
	const uint8array = textEncoder.encode(str);
	writeVarInt(buf, uint8array.length);
	checkSize(buf, uint8array.length);
	buf.encodeUA.set(uint8array, buf.offset);
	buf.offset += uint8array.length;
};
const readString = buf => {
	const length = readVarInt(buf);
	const str = length ? textDecoder.decode(buf.decodeUA.subarray(buf.offset, buf.offset + length)) : '';
	buf.offset += length;
	return str;
};
const writeBlob = (buf, blob, bytes) => { // blob = Buffer, TypedArray, or ArrayBuffer
	if (blob.byteLength === undefined) blob = defaultBlob;
	if (!blob.buffer) blob = new Uint8Array(blob); // blob was ArrayBuffer
	const length = bytes || blob.byteLength;
	if (!bytes) writeVarInt(buf, length);
	checkSize(buf, length);
	if (blob.byteLength > length) blob = new Uint8Array(blob.buffer, blob.byteOffset, length);
	if (blob.byteLength < length) buf.encodeUA.fill(0, buf.offset + blob.byteLength, buf.offset + length);
	buf.encodeUA.set(blob, buf.offset);
	buf.offset += length;
};
const readBlob = (buf, bytes) => {
	const length = bytes || readVarInt(buf);
	const blob = buf.decodeUA.subarray(buf.offset, buf.offset + length);
	buf.offset += length;
	return blob;
};
const checkSize = (buf, bytes) => {
	if (bytes + buf.offset > buf.encodeAB.byteLength) {
		const newSize = (bytes + buf.offset) * 2;
		setEncodeBuffer(buf.encodeAB.transfer(newSize), buf);
	}
};
const packInts = (o, sort) => { // efficiently packs bits(1-32) fields into 32 / 16 / 8 bit spaces
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
					ints16.push(p);
				} else if (int.schema.bits <= remaining8) {
					remaining8 -= int.schema.bits;
					ints8.push(p);
				} else fail = true;
			});
			if (fail) o.int32.push(pack);
			else { o.int16.push(ints16); o.int8.push(ints8); }
		} else (remaining < 24 ? o.int16 : o.int8).push(pack);
	}
};
const writePack = (buf, o) => {
	if (o.int8.length) for (const ints of o.int8) writeInts(buf, 1, ints);
	if (o.int16.length) for (const ints of o.int16) writeInts(buf, 2, ints);
	if (o.int32.length) for (const ints of o.int32) writeInts(buf, 4, ints);
};
const writeInts = (buf, bytes, ints) => {
	let packed = 0;
	for (const int of ints) {
		const value = int.schema.map ? int.schema.map.values[int.schema.data] : int.schema.bool ? int.schema.data ? 1 : 0 : int.schema.data;
		if (!(value >= 0 && value <= maxInt[int.schema.bits])) throw RangeError(`field "${int.schema[fieldName]}" with value "${value}" out of range [ 0 - ${maxInt[int.schema.bits]} ]`);
		packed <<= int.schema.bits;
		packed |= value;
	}
	writeUint(buf, packed >>> 0, bytes);
};
const readPack = (buf, o, array) => {
	if (o.int8.length) for (const ints of o.int8) readInts(buf, 1, ints, array);
	if (o.int16.length) for (const ints of o.int16) readInts(buf, 2, ints, array);
	if (o.int32.length) for (const ints of o.int32) readInts(buf, 4, ints, array);
	return array;
};
const readInts = (buf, bytes, ints, array) => {
	let packed = readUint(buf, bytes);
	for (let i = ints.length - 1; i >= 0; i--) {
		const val = ints.length > 1 ? packed % (1 << ints[i].schema.bits) : packed;
		const data = ints[i].schema.bool ? Boolean(val) : ints[i].schema.map?.index[val] ?? val;
		if (array) array[ints[i].schema.index] = data;
		else ints[i].schema.data = data;
		packed >>>= ints[i].schema.bits;
	}
};
const setData = (schema, data) => {
	for (const field in schema) {
		if (schema[field].bits) schema[field].data = data[field] || 0;
		if (isObject(schema[field])) setData(schema[field], data[field]);
	}
};
const genMap = values => {
	const bits = numberToBits(values.length - 1);
	return {
		bits,
		bytes: Math.ceil(bits / 8),
		index: values,
		values: values.reduce((obj, v, i) => (obj[v] = i, obj), {}),
	};
};

const arrayPackSizes = [ 0, 8, 8, 15, 8, 15, 30, 0, 0, 27, 30 ];
const isObject = schema => !schema._type;
const maxInt = Array.from(Array(33), (x, i) => 2**i - 1);
const numberToBits = num => Math.ceil(Math.log2(num + 1)) || 1;
const bitsToBytes = bits => Math.ceil(bits / 8);
const newPack = (ints = []) => ({ ints, int8: [], int16: [], int32: [] });
const uint8arrayToHex = uint8 => uint8.reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '');
const useArrayPacking = s => s.bits && s._type && (s.bits <= 6 || s.bits == 9 || s.bits == 10);
const fieldName = Symbol('fieldName');
const pack = Symbol('pack');
const defaultBlob = new Uint8Array(0);
const defaultObjectID = { id: new Uint8Array(12) };
const defaultUUID = { buffer: new Uint8Array(16) };
const defaultDate = new Date(0);
const defaultLonlat = [ 0, 0 ];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const genType = (_type) => {
	const fn = val => ({ _type, val, size: function(s) { this._size = s; return this; } });
	fn.toJSON = () => ({ _type });
	fn._type = _type;
	return fn;
};

export const [ bool, bits, float, varint, string, blob, date, array, union, select ] =
			[ 'bool', 'bits', 'float', 'varint', 'string', 'blob', 'date', 'array', 'union', 'select' ].map(genType);
