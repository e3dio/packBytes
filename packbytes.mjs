export const PackBytes = (schema) => {
	initialize(schema = parse(schema));
	const buf = setEncodeBuffer(new ArrayBuffer(2 ** 14));
	return {
		encode: (name, data) => {
			buf.offset = 0;
			encodeSchema(buf, schema, parseInputs(name, data));
			return new Uint8Array(buf.encodeAB, 0, buf.offset);
		},
		decode: (buffer) => decodeSchema(decodeBuffer(buffer), schema),
	};
};

const types = {
	bool: {
		encode: (buf, schema, data = 0) => writeUint(buf, data, 1),
		decode: (buf, schema) => Boolean(readUint(buf, 1)),
		init: (schema) => {
			schema.bits = 1; // schemas with "bits" field get packed into 32 bit spaces by packInts() if schema is child of object, skipping encode() fn
			schema.bool = true;
		},
	},
	bits: {
		encode: (buf, schema, data = 0) => writeUint(buf, data, schema.bytes),
		decode: (buf, schema) => readUint(buf, schema.bytes),
		init: (schema) => {
			if (!(schema.val >= 1 && schema.val <= 32)) throw TypeError(`bit size must be 1 - 32, received "${schema.val}"`);
			schema.bits = schema.val;
			schema.bytes = Math.ceil(schema.bits / 8);
		},
	},
	float: {
		encode: (buf, schema, data = 0) => writeFloat(buf, data, schema.bytes),
		decode: (buf, schema) => readFloat(buf, schema.bytes),
		init: (schema) => {
			if (schema.val != 32 && schema.val != 64) throw TypeError(`float must be 32 or 64 bit, received "${schema.val}"`);
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
				const int = schema.map.values[data];
				if (int === undefined) throw RangeError(`field "${schema[fieldName]}" with string "${data}" not found in [${schema.map.index}]`);
				writeUint(buf, int, schema.map.bytes) 
			} else writeString(buf, data);
		},
		decode: (buf, schema) => schema.map ? schema.map.index[readUint(buf, schema.map.bytes)] : readString(buf),
		init: (schema) => {
			if (schema.val) {
				schema.map = genMap(schema.val);
				schema.bits = schema.map.bits;
			}
		},
	},
	blob: {
		encode: (buf, schema, data = defaultBlob) => writeBlob(buf, data, schema.val),
		decode: (buf, schema) => readBlob(buf, schema.val),
	},
	objectid: {
		encode: (buf, schema, data = defaultObjectID) => writeBlob(buf, data.id, 12),
		decode: (buf, schema) => uint8arrayToHex(readBlob(buf, 12)),
	},
	uuid: {
		encode: (buf, schema, data = defaultUUID) => writeBlob(buf, data.buffer, 16),
		decode: (buf, schema) => readBlob(buf, 16),
	},
	date: {
		encode: (buf, schema, data = defaultDate) => writeFloat(buf, data.getTime(), schema.val == 32 ? 4 : 8),
		decode: (buf, schema) => new Date(readFloat(buf, schema.val == 32 ? 4 : 8)),
	},
	lonlat: {
		encode: (buf, schema, data = defaultLonlat) => {
			writeUint(buf, (data[0] + 180) * 1e7, 4);
			writeUint(buf, (data[1] + 90) * 1e7, 4);
		},
		decode: (buf, schema) => [ readUint(buf, 4) / 1e7 - 180, readUint(buf, 4) / 1e7 - 90 ],
	},
	array: {
		encode: (buf, schema, data = []) => {
			const childSchema = schema.val;
			if (!schema._size) writeVarInt(buf, data.length);
			if (useArrayPacking(childSchema)) {
				const p = newPack();
				data.forEach((d, i) => p.ints.push({ bits: childSchema.val, index: i, data: d }));
				packInts(p);
				writePack(buf, p);
			} else for (const item of data) encodeSchema(buf, childSchema, item);
		},
		decode: (buf, schema) => {
			const childSchema = schema.val;
			const length = schema._size || readVarInt(buf);
			if (useArrayPacking(childSchema)) {
				const p = newPack();
				for (let i = 0; i < length; i++) p.ints.push({ bits: childSchema.val, index: i });
				packInts(p);
				return readPack(buf, p, Array(length));
			}
			const arr = [];
			for (let i = length; i > 0; i--) arr.push(decodeSchema(buf, childSchema));
			return arr;
		},
		init: (schema) => initialize(schema.val),
	},
	schemas: {
		encode: (buf, schema, data) => {
			const index = schema.map.values[data[0]];
			if (index === undefined) throw Error(`Packbytes: schema "${data[0]}" not found in ${JSON.stringify(schema.map.index)}`);
			writeVarInt(buf, index);
			const dataSchema = schema.val[data[0]];
			encodeSchema(buf, dataSchema, data[1]);
		},
		decode: (buf, schema) => {
			const name = schema.map.index[readVarInt(buf)];
			const dataSchema = schema.val[name];
			return [ name, decodeSchema(buf, dataSchema) ];
		},
		init: (schema) => {
			schema.map = genMap(Object.keys(schema.val));
			Object.values(schema.val).forEach(schema => initialize(schema));
		}
	},
	object: {
		encode: (buf, schema, data) => {
			const p = schema[pack];
			if (p) {
				setData(schema, data); // attaches bits data to schema
				writePack(buf, p);
			}
			for (const field in schema) {
				const childSchema = schema[field];
				const childData = data[field];
				if (!childSchema.bits) encodeSchema(buf, childSchema, childData);
			}
		},
		decode: (buf, schema) => {
			const obj = {}, p = schema[pack];
			if (p) readPack(buf, p); // attaches decoded value to schema
			for (const field in schema) {
				const childSchema = schema[field];
				obj[field] = childSchema.decoded ?? decodeSchema(buf, childSchema);
			}
			return obj;
		},
		init: (schema, parentPack) => {
			const p = parentPack || (schema[pack] = newPack()); // use parent objectSchema else create new objectSchema and attach to object
			for (const field in schema) {
				const childSchema = schema[field];
				childSchema[fieldName] = field;
				initialize(childSchema, p);
				if (childSchema.bits) p.ints.push(childSchema);
			}
			if (!parentPack && p.ints.length) packInts(p, true); // packInts if current object has no parent object
		},
	},
	null: { encode: () => {}, decode: () => null },
};

const type = (schema) => types[schema ? schema._type || 'object' : 'null'];
const parse = (schema) => JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
const initialize = (schema, pack) => type(schema).init?.(schema, pack);
const parseInputs = (schemaName, data) => data === undefined ? schemaName : [ schemaName, data ];
const encodeSchema = (buf, schema, data) => type(schema).encode(buf, schema, data);
const decodeSchema = (buf, schema) => type(schema).decode(buf, schema);
const setEncodeBuffer = (arrayBuffer, buf = {}) => {
	buf.encodeAB = arrayBuffer;
	buf.encodeDV = new DataView(arrayBuffer); 
	buf.encodeUA = new Uint8Array(arrayBuffer);
	return buf;
};
const decodeBuffer = (b) => ({ // b = Buffer, TypedArray, or ArrayBuffer
	decodeDV: b.buffer ? new DataView(b.buffer, b.byteOffset, b.byteLength) : new DataView(b),
	decodeUA: b.buffer ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b),
	offset: 0,
});

const writeUint = (buf, val, bytes) => {
	checkSize(buf, bytes);
	buf.encodeDV[({ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' })[bytes]](buf.offset, val);
	buf.offset += bytes;
};
const readUint = (buf, bytes) => {
	var int = buf.decodeDV[({ 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' })[bytes]](buf.offset);
	buf.offset += bytes;
	return int;
};
const writeFloat = (buf, val, bytes) => {
	checkSize(buf, bytes);
	buf.encodeDV[({ 4: 'setFloat32', 8: 'setFloat64'})[bytes]](buf.offset, val);
	buf.offset += bytes;
};
const readFloat = (buf, bytes) => {
	const float = buf.decodeDV[({ 4: 'getFloat32', 8: 'getFloat64' })[bytes]](buf.offset);
	buf.offset += bytes;
	return float;
};
const writeVarInt = (buf, int) => {
	if (int <= 127) return writeUint(buf, int, 1);
	if (int <= 16_383) return writeUint(buf, ((int & 0b11_1111_1000_0000) << 1) | (int & 0b111_1111) | 0b1000_0000_0000_0000, 2);
	if (int <= 1_073_741_823) return writeUint(buf, ((int & 0b11_1111_1000_0000_0000_0000_0000_0000) << 1) | (int & 0b111_1111_1111_1111_1111_1111) | 0b1000_0000_1000_0000_0000_0000_0000_0000, 4);
	throw RangeError(`varInt max 1,073,741,823 exceeded: "${int}"`);
};
const readVarInt = (buf) => {
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
const readString = (buf) => {
	const length = readVarInt(buf);
	const str = length ? textDecoder.decode(buf.decodeUA.subarray(buf.offset, buf.offset + length)) : '';
	buf.offset += length;
	return str;
};
const writeBlob = (buf, blob, bytes) => { // takes TypedArray, Buffer, ArrayBuffer
	if (blob.byteLength === undefined) throw TypeError(`writeBlob() expected TypedArray, Buffer, or ArrayBuffer, received "${buf}"`);
	if (!blob.buffer) blob = new Uint8Array(blob); // ArrayBuffer
	const length = bytes || blob.byteLength;
	if (!bytes) writeVarInt(buf, length);
	else if (blob.byteLength != bytes) throw RangeError(`buffer size mismatch: "${blob.byteLength}" != "${bytes}" for buffer "${blob}"`);
	checkSize(buf, length);
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
		if (buf.encodeAB.transfer) setEncodeBuffer(buf.encodeAB.transfer(buf.encodeAB.byteLength * 2), buf);
		else { // backwards compatible for <= Node v20
			const uint8Array = buf.encodeUA;
			setEncodeBuffer(new ArrayBuffer(buf.encodeAB.byteLength * 2), buf);
			buf.encodeUA.set(uint8Array);
		}
		checkSize(buf, bytes);
	}
};
const packInts = (o, sort) => { // efficiently packs bits(1-32) fields into 32 / 16 / 8 bit spaces
	if (sort) o.ints.sort((a, b) => b.bits - a.bits);
	while (o.ints.length) {
		let ints32 = [], remaining = 32;
		for (let i = 0; i < o.ints.length; i++) {
			if (o.ints[i].bits <= remaining) {
				remaining -= o.ints[i].bits;
				ints32.push(...o.ints.splice(i--, 1));
				if (!remaining) break;
			}
		}
		if (remaining < 8) o.int32.push(ints32);
		else if (remaining < 16) { // try to fit into 16 + 8 space
			let ints16 = [], ints8 = [], remaining16 = 16, remaining8 = 8, fail;
			for (let i = 0; i < ints32.length; i++) {
				if (ints32[i].bits <= remaining16) {
					remaining16 -= ints32[i].bits;
					ints16.push(ints32[i]);
				} else if (ints32[i].bits <= remaining8) {
					remaining8 -= ints32[i].bits;
					ints8.push(ints32[i]);
				} else { // failed to fit into 16 + 8, use 32
					fail = true;
					break;
				}
			}
			if (fail) o.int32.push(ints32);
			else { o.int16.push(ints16); o.int8.push(ints8); }
		} else (remaining < 24 ? o.int16 : o.int8).push(ints32);
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
		const value = int.map ? int.map.values[int.data] : int.bool ? int.data ? 1 : 0 : int.data;
		if (!(value >= 0 && value <= maxInt[int.bits])) throw RangeError(`field "${int[fieldName]}" with value "${value}" out of range [ 0 - ${maxInt[int.bits]} ]`);
		packed <<= int.bits;
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
		const val = ints.length > 1 ? packed % (1 << ints[i].bits) : packed;
		const decoded = ints[i].bool ? Boolean(val) : ints[i].map?.index[val] ?? val;
		if (array) array[ints[i].index] = decoded;
		else ints[i].decoded = decoded;
		packed >>>= ints[i].bits;
	}
};
const setData = (schema, data) => {
	for (const field in schema) {
		const childSchema = schema[field];
		const childData = data?.[field] || 0;
		if (childSchema.bits) childSchema.data = childData;
		if (isObject(childSchema)) setData(childSchema, childData);
	}
};
const genMap = (values) => {
	const bits = numberToBits(values.length - 1);
	return {
		bits,
		bytes: Math.ceil(bits / 8),
		index: values,
		values: values.reduce((obj, v, i) => (obj[v] = i, obj), {}),
	};
};

const isObject = schema => !schema._type;
const maxInt = Array.from(Array(33), (x, i) => 2**i - 1);
const numberToBits = (num) => Math.ceil(Math.log2(num + 1)) || 1;
const newPack = () => ({ ints: [], int8: [], int16: [], int32: [] });
const uint8arrayToHex = (uint8) => uint8.reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '');
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

export const [ bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas ] =
	[ 'bool', 'bits', 'float', 'varint', 'string', 'blob', 'objectid', 'uuid', 'date', 'lonlat', 'array', 'schemas' ].map(genType);
