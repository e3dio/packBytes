const Pack = (schema, bufferSize = 4096) => {
	initialize(schema = parseJSON(schema));
	const buf = setEncodeBuffer(new ArrayBuffer(bufferSize));
	return {
		encode: data => {
			buf.offset = 0;
			encodeSchema(schema, buf, data);
			return new Uint8Array(buf.encodeAB, 0, buf.offset);
		},
		decode: buffer => decodeSchema(schema, setDecodeBuffer(buffer)),
	};
};

const types = {
	bool: {
		encode: (schema, buf, data) => writeUint(buf, data, 1),
		decode: (schema, buf) => Boolean(readUint(buf, 1)),
		init: schema => {
			schema.bits = 1; // schemas with "bits" field get packed into 8, 16, or 32 bit spaces by packInts() if schema is child of object, skipping encode/decode fn
			schema.bool = true;
		},
	},
	bits: {
		encode: (schema, buf, data) => writeUint(buf, data, schema.bytes),
		decode: (schema, buf) => readUint(buf, schema.bytes),
		init: schema => {
			if (!(schema.val >= 1 && schema.val <= 32)) throw TypeError(`bit size must be 1 to 32, got "${schema.val}"`);
			schema.bits = schema.val;
			schema.bytes = schema.bits > 16 ? 4 : schema.bits > 8 ? 2 : 1;
		},
	},
	int: {
		encode: (schema, buf, data) => writeInt(buf, data, schema.bytes),
		decode: (schema, buf) => readInt(buf, schema.bytes),
		init: schema => {
			if (![ 8, 16, 32 ].includes(schema.val)) throw TypeError(`int must be 8, 16, or 32 bits, got "${schema.val}"`);
			schema.bytes = schema.val / 8;
		},
	},
	float: {
		encode: (schema, buf, data) => writeFloat(buf, data, schema.bytes),
		decode: (schema, buf) => readFloat(buf, schema.bytes),
		init: schema => {
			if (![ 16, 32, 64 ].includes(schema.val)) throw TypeError(`float must be 16, 32, or 64 bits, got "${schema.val}"`);
			schema.bytes = schema.val / 8;
		},
	},
	varint: {
		encode: (schema, buf, data) => writeVarInt(buf, data),
		decode: (schema, buf) => readVarInt(buf),
	},
	string: {
		encode: (schema, buf, data) => writeString(buf, data),
		decode: (schema, buf) => readString(buf),
	},
	blob: {
		encode: (schema, buf, data) => writeBlob(buf, data, schema.val),
		decode: (schema, buf) => readBlob(buf, schema.val),
	},
	array: {
		encode: (schema, buf, data = []) => {
			if (!schema.length) writeVarInt(buf, data.length);
			if (schema.packSize) {
				const len = data.length - 1;
				var pack = 0;
				data.forEach((d, i) => {
					pack <<= schema.val.bits;
					pack += minmax(d, 0, maxInt[schema.val.bits]);
					if (!((i + 1) % schema.packSize) || i == len) {
						writeUint(buf, pack, schema.packBytes);
						pack = 0;
					}
				});
			} else for (const d of data) encodeSchema(schema.val, buf, d);
		},
		decode: (schema, buf) => {
			const arr = [], length = schema.length || readVarInt(buf);
			if (schema.packSize) {
				var pack, packArr = [];;
				for (let i = 0; i < length; i++) {
					if (!(i % schema.packSize)) {
						while (packArr.length) arr.push(packArr.pop());
						pack = readUint(buf, schema.packBytes);
					}
					const val = pack % schema.itemSize;
					packArr.push(schema.val.bool ? Boolean(val) : val);
					pack >>>= schema.val.bits;
					if (!((i + 1) % schema.packSize)) {
						while (packArr.length) arr.push(packArr.pop());
					}
				}
				while (packArr.length) arr.push(packArr.pop());
			} else for (let i = 0; i < length; i++) arr.push(decodeSchema(schema.val, buf));
			return arr;
		},
		init: schema => {
			if (!schema.val) throw TypeError(`array must have child type`);
			initialize(schema.val);
			if (schema.val.bits) {
				schema.packSize = arrayPackCount[schema.val.bits];
				schema.packBytes = bitsToBytes(schema.packSize * schema.val.bits);
				schema.itemSize = 2**schema.val.bits;
			}
		},
	},
	object: {
		encode: (schema, buf, data) => {
			if (schema[pack]) {
				setData(schema, data);
				writePack(buf, schema[pack]);
			}
			for (const field in schema) if (!schema[field].bits) encodeSchema(schema[field], buf, data[field]);
		},
		decode: (schema, buf) => {
			const obj = {}, p = schema[pack];
			if (p) readPack(buf, p); // attaches decoded value to schema
			for (const field in schema) {
				const childSchema = schema[field];
				obj[field] = childSchema.data ?? decodeSchema(childSchema, buf);
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
	selectOne: {
		encode: (schema, buf, data) => {
			for (const f in data) {
				writeUint(buf, schema.map.values[f], schema.map.bytes);
				encodeSchema(schema.val[f], buf, data[f]);
				break;
			}
		},
		decode: (schema, buf) => {
			const field = schema.map.index[readUint(buf, schema.map.bytes)];
			return { [field]: decodeSchema(schema.val[field], buf) };
		},
		init: schema => {
			schema.map = genMap(Object.keys(schema.val));
			Object.values(schema.val).forEach(schema => initialize(schema));
		}
	},
	selectMany: {
		encode: (schema, buf, data) => {
			let bit_field = 0, field_index = 0;
			for (const f in schema.val) {
				if (field_index == 32) { // max 32 fields per u32
					writeUint(buf, bit_field, 4);
					bit_field = field_index = 0;
				}
				if (data[f] !== undefined) bit_field += 1<<field_index; // active field
				field_index += 1;
			}
			writeUint(buf, bit_field, bitsToBytes(field_index));
			for (const f in schema.val) if (data[f] !== undefined) encodeSchema(schema.val[f], buf, data[f]);
		},
		decode: (schema, buf) => {
			const obj = {}, field_count = schema.map.index.length;
			var field_index = 0;
			while (field_index < field_count) {
				const fields_in_group = Math.min(32, field_count - field_index); // process up to 32 fields per group
				const bit_field = readUint(buf, bitsToBytes(fields_in_group));
				for (let index_in_group = 0; index_in_group < fields_in_group; index_in_group++) {
					if (bit_field & 1<<index_in_group) { // active field
						const f = schema.map.index[field_index];
						obj[f] = decodeSchema(schema.val[f], buf);
					}
					field_index++;
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

const type = schema => types[schema && (schema._type || 'object')];
const parseJSON = schema => JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
const initialize = (schema, pack) => type(schema).init?.(schema, pack);
const encodeSchema = (schema, buf, data) => type(schema).encode(schema, buf, data);
const decodeSchema = (schema, buf) => type(schema).decode(schema, buf);
const setEncodeBuffer = (arrayBuffer, buf = {}) => {
	buf.encodeAB = arrayBuffer;
	buf.encodeDV = new DataView(arrayBuffer); 
	buf.encodeUA = new Uint8Array(arrayBuffer);
	return buf;
};
const setDecodeBuffer = b => ({ // b = Buffer, TypedArray, or ArrayBuffer
	decodeDV: b.buffer ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b),
	decodeUA: b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b),
	offset: 0,
});

const writeInt = (buf, val, bytes) => {
	checkSize(buf, bytes);
	bytes == 1 ? buf.encodeDV.setInt8(buf.offset, minmax(val, -128, 127)) :
	bytes == 2 ? buf.encodeDV.setInt16(buf.offset, minmax(val, -32768, 32767)) :
		buf.encodeDV.setInt32(buf.offset, minmax(val, -2147483648, 2147483647));
	buf.offset += bytes;
};
const readInt = (buf, bytes) => {
	const int =
		bytes == 1 ? buf.decodeDV.getInt8(buf.offset) :
		bytes == 2 ? buf.decodeDV.getInt16(buf.offset) :
			buf.decodeDV.getInt32(buf.offset);
	buf.offset += bytes;
	return int;
};
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
const writeFloat = (buf, val = 0, bytes) => {
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
const writeVarInt = (buf, int = 0) => {
	if (int <= 0) writeUint(buf, 0, 1);
	else if (int <= 127) writeUint(buf, int, 1);
	else if (int <= 16_383) writeUint(buf, 128 + (int & 63), 1), writeUint(buf, int >>> 6, 1);
	else {
		if (int > 1073741823) throw Error(`writeVarInt "${int}" exceeds max 1073741823`);
		writeUint(buf, 192 + (int & 63), 1), writeUint(buf, int >>> 6, 1), writeUint(buf, int >>> 14, 2);
	}
};
const readVarInt = buf => {
	const val = readUint(buf, 1);
	if (val < 128) return val;
	if (val < 192) return (val - 128) + (readUint(buf, 1) << 6);
	return (val - 192) + (readUint(buf, 1) << 6) + (readUint(buf, 2) << 14);
};
const writeString = (buf, str) => {
	if (!str) return writeUint(buf, 0, 1);
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
	if (!bytes && !blob?.byteLength) return writeUint(buf, 0, 1);
	if (!blob.buffer) blob = new Uint8Array(blob); // blob was ArrayBuffer
	else if (blob.BYTES_PER_ELEMENT != 1) blob = new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength);
	const length = bytes ?? blob.byteLength;
	bytes ?? writeVarInt(buf, length);
	checkSize(buf, length);
	if (blob.byteLength < length) buf.encodeUA.fill(0, buf.offset + blob.byteLength, buf.offset + length);
	else if (blob.byteLength > length) blob = new Uint8Array(blob.buffer, blob.byteOffset, length);
	buf.encodeUA.set(blob, buf.offset);
	buf.offset += length;
};
const readBlob = (buf, bytes) => {
	const length = bytes == undefined ? readVarInt(buf) : bytes;
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

const arrayPackCount = [ 0, 8, 4, 5, 2, 3, 5, 0, 0, 3, 3 ];
const isObject = schema => !schema._type;
const maxInt = Array.from(Array(33), (x, i) => 2**i - 1);
const numberToBits = num => Math.ceil(Math.log2(num + 1)) || 1;
const bitsToBytes = bits => Math.ceil(bits / 8);
const newPack = (ints = []) => ({ ints, int8: [], int16: [], int32: [] });
const uint8arrayToHex = uint8 => uint8.reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '');
const useArrayPacking = s => s.bits && s._type && (s.bits <= 6 || s.bits == 9 || s.bits == 10);
const minmax = (val, min, max) => Math.min(max, Math.max(min, val));
const fieldName = Symbol('fieldName');
const pack = Symbol('pack');
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const genType = _type => {
	const fn = (val, length) => ({ _type, val, length });
	fn.toJSON = () => ({ _type });
	fn._type = _type;
	return fn;
};

export default Object.keys(types).reduce((o, t) => (o[t] = genType(t), o), { Pack });
