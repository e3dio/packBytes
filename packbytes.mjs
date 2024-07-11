export const PackBytes = (schema) => {
	const init = () => {
		initialize(schema = parse(schema));
		setEncodeBuffer(new ArrayBuffer(2 ** 14));
		return { encode, decode };
	};
	const encode = (name, data) => {
		offset = 0;
		encodeSchema(schema, parseInputs(name, data));
		return new Uint8Array(encodeAB, 0, offset);
	};
	const decode = (buf) => {
		offset = 0;
		setDecodeBuffer(buf);
		return decodeSchema(schema);
	};
	const types = {
		bool: {
			encode: (schema, data = 0) => writeUint(data, 1),
			decode: (schema) => Boolean(readUint(1)),
			init: (schema) => {
				schema.bool = true;
				schema.bits = 1; // schemas with "bits" field get packed into 32 bit spaces by packInts() if schema is child of object, skipping encode() fn
			},
		},
		bits: {
			encode: (schema, data = 0) => {
				if (!(data >= 0 && data <= schema.maxByteInt)) throw rangeError(schema, data);
				writeUint(data, schema.bytes);
			},
			decode: (schema) => readUint(schema.bytes),
			init: (schema) => {
				if (!(schema.val >= 1 && schema.val <= 32)) throw TypeError(`bit size must be 1 - 32, received "${schema.val}"`);
				schema.bits = schema.val;
				schema.bytes = Math.ceil(schema.bits / 8);
				schema.maxInt = 2**schema.bits - 1;
				schema.maxByteInt = 2**(schema.bytes * 8) - 1;
			},
		},
		float: {
			encode: (schema, data = 0) => writeFloat(data, schema.bytes),
			decode: (schema) => readFloat(schema.bytes),
			init: (schema) => {
				if (val != 32 || val != 64) throw TypeError(`float must be 32 or 64 bit, received "${val}"`);
				schema.bytes = schema.val / 8;
			},
		},
		varint: {
			encode: (schema, data = 0) => {
				if (!(data >= 0 && data <= schema.maxByteInt)) throw rangeError(schema, data);
				writeVarInt(data);
			},
			decode: (schema) => readVarInt(),
			init: (schema) => schema.maxByteInt = 2**30 - 1,
		},
		string: {
			encode: (schema, data = '') => {
				if (schema.map) {
					const int = schema.map.values[data];
					if (int === undefined) throw RangeError(`field "${schema[fieldName]}" with string "${data}" not found in [${schema.map.index}]`);
					writeUint(int, schema.map.bytes) 
				} else writeString(data);
			},
			decode: (schema) => schema.map ? schema.map.index[readUint(schema.map.bytes)] : readString(),
			init: (schema) => {
				if (schema.val) {
					if (!schema.val.length) throw TypeError(`schema string(value) must be array of strings`);
					schema.map = genMap(schema.val);
					schema.bits = schema.map.bits;
					schema.maxInt = 2**schema.bits - 1;
				}
			},
		},
		blob: {
			encode: (schema, data = defaultBlob) => writeBlob(data, schema.val),
			decode: (schema) => readBlob(schema.val),
		},
		objectid: {
			encode: (schema, data = defaultObjectID) => writeBlob(data.id, 12),
			decode: (schema) => uint8arrayToHex(readBlob(12)),
		},
		uuid: {
			encode: (schema, data = defaultUUID) => writeBlob(data.buffer, 16),
			decode: (schema) => readBlob(16),
		},
		date: {
			encode: (schema, data = defaultDate) => {
				const seconds = Math.floor(data.getTime() / 1000);
				if (data < 0 || seconds > 4_294_967_295) throw Error(`date ${date} outside range ${new Date(0)} - ${new Date(4294967295000)}`);
				writeUint(seconds, 4);
			},
			decode: (schema) => new Date(readUint(4) * 1000),
		},
		lonlat: {
			encode: (schema, data = defaultLonlat) => {
				writeUint((data[0] + 180) * 1e7, 4);
				writeUint((data[1] + 90) * 1e7, 4);
			},
			decode: (schema) => [ readUint(4) / 1e7 - 180, readUint(4) / 1e7 - 90 ],
		},
		array: {
			encode: (schema, data = []) => {
				if (!schema._size) writeVarInt(data.length);
				for (const item of data) encodeSchema(schema.val, item);
			},
			decode: (schema) => {
				const arr = [];
				const length = schema._size || readVarInt();
				for (let i = length; i > 0; i--) {
					const x = decodeSchema(schema.val);
					arr.push(x);
				}
				return arr;
			},
			init: (schema) => initialize(schema.val),
		},
		schemas: {
			encode: (schema, data) => {
				const index = schema.map.values[data[0]];
				if (index === undefined) throw Error(`Packbytes: schema "${data[0]}" not found in ${JSON.stringify(schema.map.index)}`);
				writeVarInt(index);
				const dataSchema = schema.val[data[0]];
				encodeSchema(dataSchema, data[1]);
			},
			decode: (schema) => {
				const name = schema.map.index[readVarInt()];
				const dataSchema = schema.val[name];
				return [ name, decodeSchema(dataSchema) ];
			},
			init: (schema) => {
				schema.map = genMap(Object.keys(schema.val));
				Object.values(schema.val).forEach(schema => initialize(schema));
			}
		},
		object: {
			encode: (schema, data) => {
				const o = schema[objSchema];
				if (o) {
					setData(schema, data); // attaches bits data to schema
					if (o.int8.length) for (const ints of o.int8) writeInts(1, ints);
					if (o.int16.length) for (const ints of o.int16) writeInts(2, ints);
					if (o.int32.length) for (const ints of o.int32) writeInts(4, ints);
				}
				for (const field in schema) {
					const childSchema = schema[field];
					const childData = data[field];
					if (!childSchema.bits) encodeSchema(childSchema, childData);
				}
			},
			decode: (schema) => {
				const obj = {}, o = schema[objSchema];
				if (o) {
					if (o.int8.length) for (const ints of o.int8) readInts(1, ints); // attaches decoded value to schema
					if (o.int16.length) for (const ints of o.int16) readInts(2, ints);
					if (o.int32.length) for (const ints of o.int32) readInts(4, ints);
				}
				for (const field in schema) {
					const childSchema = schema[field];
					obj[field] = childSchema.decoded ?? decodeSchema(childSchema);
				}
				return obj;
			},
			init: (schema, parentObjSchema) => {
				const o = parentObjSchema || (schema[objSchema] = newObjSchema()); // use parent objectSchema else create new objectSchema and attach to object
				for (const field in schema) {
					const childSchema = schema[field];
					childSchema[fieldName] = field;
					initialize(childSchema, o);
					if (childSchema.bits) o.ints.push(childSchema);
				}
				if (!parentObjSchema && o.ints.length) packInts(o); // packInts if current object has no parent object
			},
		},
		null: { encode: () => {}, decode: () => null },
	};
	const type = (schema) => types[schema ? schema._type || 'object' : 'null'];
	const initialize = (schema, objSchema) => type(schema).init?.(schema, objSchema);
	const parseInputs = (schemaName, data) => data ? [ schemaName, data ] : schemaName;
	const encodeSchema = (schema, data) => type(schema).encode(schema, data);
	const decodeSchema = (schema, data) => type(schema).decode(schema);
	const setEncodeBuffer = (arrayBuffer) => {
		encodeAB = arrayBuffer;
		encodeDV = new DataView(arrayBuffer); 
		encodeUA = new Uint8Array(arrayBuffer);
	};
	const setDecodeBuffer = (buf) => {
		decodeDV = buf.buffer ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : new DataView(buf);
		decodeUA = buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
	};
	const readString = () => {
		const length = readVarInt();
		const str = length ? textDecoder.decode(decodeUA.subarray(offset, offset + length)) : '';
		offset += length;
		return str;
	};
	const writeString = (str) => {
		const uint8array = textEncoder.encode(str);
		writeVarInt(uint8array.length);
		checkSize(uint8array.length);
		new Uint8Array(encodeDV.buffer, offset, uint8array.length).set(uint8array);
		offset += uint8array.length;
	};
	const readBlob = (bytes) => {
		const length = bytes || readVarInt();
		const blob = decodeUA.subarray(offset, offset + length);
		offset += length;
		return blob;
	};
	const writeBlob = (buf, bytes) => { // takes TypedArray, Buffer, ArrayBuffer
		if (buf.byteLength === undefined) throw TypeError(`writeBlob() expected TypedArray, Buffer, or ArrayBuffer, received "${buf}"`);
		if (!buf.buffer) buf = new Uint8Array(buf); // ArrayBuffer
		const length = bytes || buf.byteLength;
		if (!bytes) writeVarInt(length);
		else if (buf.byteLength != bytes) throw RangeError(`buffer size mismatch: "${buf.byteLength}" != "${bytes}" for buffer "${buf}"`);
		checkSize(length);
		encodeUA.set(buf, offset);
		offset += length;
	};
	const readUint = (bytes) => {
		var int = decodeDV[({ 1: 'getUint8', 2: 'getUint16', 4: 'getUint32' })[bytes]](offset);
		offset += bytes;
		return int;
	};
	const writeUint = (val, bytes) => {
		checkSize(bytes);
		encodeDV[({ 1: 'setUint8', 2: 'setUint16', 4: 'setUint32' })[bytes]](offset, val);
		offset += bytes;
	};
	const readFloat = (bytes) => {
		const float = decodeDV[({ 4: 'getFloat32', 8: 'getFloat64' })[bytes]](offset);
		offset += bytes;
		return float;
	};
	const writeFloat = (val, bytes) => {
		checkSize(bytes);
		encodeDV[({ 4: 'setFloat32', 8: 'setFloat64'})[bytes]](offset, val);
		offset += bytes;
	};
	const readVarInt = () => {
		let val = readUint(1);
		if (val < 128) return val;
		offset--; val = readUint(2);
		if (!(val & 0b1000_0000)) return ((val & 0b111_1111_0000_0000) >> 1) | (val & 0b111_1111);
		offset -= 2; val = readUint(4);
		return ((val & 0b111_1111_0000_0000_0000_0000_0000_0000) >> 1) | (val & 0b111_1111_1111_1111_1111_1111);
	};
	const writeVarInt = (int) => {
		if (int <= 127) return writeUint(int, 1);
		if (int <= 16_383) return writeUint(((int & 0b11_1111_1000_0000) << 1) | (int & 0b111_1111) | 0b1000_0000_0000_0000, 2);
		if (int <= 1_073_741_823) return writeUint(((int & 0b11_1111_1000_0000_0000_0000_0000_0000) << 1) | (int & 0b111_1111_1111_1111_1111_1111) | 0b1000_0000_1000_0000_0000_0000_0000_0000, 4);
		throw RangeError(`varInt max 1,073,741,823 exceeded: "${int}"`);
	};
	const readInts = (bytes, ints) => {
		let packed = readUint(bytes);
		if (ints.length > 1) for (let i = ints.length - 1; i >= 0; i--) {
			const val = packed % (1 << ints[i].bits);
			ints[i].decoded = ints[i].bool ? Boolean(val) : ints[i].map?.index[val] ?? val;
			packed >>>= ints[i].bits;
		} else ints[0].decoded = ints[0].bool ? Boolean(packed) : ints[0].map?.index[packed] ?? packed;
	};
	const writeInts = (bytes, ints) => {
		let packed = 0;
		for (const int of ints) {
			const value = int.map ? int.map.values[int.data] : int.bool ? int.data ? 1 : 0 : int.data;
			if (!(value >= 0 && value <= int.maxInt)) throw rangeError(int, value, int.maxInt);
			packed <<= int.bits;
			packed |= value
		}
		writeUint(packed >>> 0, bytes);
	};
	const checkSize = (bytes) => {
		if (bytes + offset > encodeAB.byteLength) {
			if (encodeAB.transfer) setEncodeBuffer(encodeAB.transfer(encodeAB.byteLength * 2));
			else { // backwards compatible for <= Node v20
				const uint8Array = encodeUA;
				setEncodeBuffer(new ArrayBuffer(encodeAB.byteLength * 2));
				encodeUA.set(uint8Array);
			}
			checkSize(bytes);
		}
	};

	let offset, encodeAB, encodeDV, encodeUA, decodeDV, decodeUA;

	return init();
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
const packInts = (o) => {
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
const setData = (schema, data) => {
	for (const field in schema) {
		const childSchema = schema[field];
		const childData = data[field];
		if (childSchema.bits) childSchema.data = childData; // attaches data to schema
		if (!childSchema._type) {
			if (childData === undefined) throw Error(`Packbytes: no data for field "${field}"`);
			setData(childSchema, childData);
		}
	}
};
const parse = (schema) => JSON.parse(typeof schema == 'string' ? schema : JSON.stringify(schema));
const numberToBits = (num) => Math.ceil(Math.log2(num + 1)) || 1;
const newObjSchema = () => ({ ints: [], int8: [], int16: [], int32: [] });
const getVarIntSize = (int) => int < 128 ? 1 : int < 16_384 ? 2 : 4;
const uint8arrayToHex = (uint8) => uint8.reduce((hex, byte) => hex + byte.toString(16).padStart(2, '0'), '');
const fieldName = Symbol('fieldName');
const objSchema = Symbol('objSchema');
const defaultBlob = new Uint8Array(0);
const defaultObjectID = { id: new Uint8Array(12) };
const defaultUUID = { buffer: new Uint8Array(16) };
const defaultDate = new Date(0);
const defaultLonlat = [ 0, 0 ];
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const rangeError = (schema, data, max) => RangeError(`field "${schema[fieldName]}" with value "${data}" out of range [ 0 - ${max || schema.maxByteInt} ]`);
const genType = (_type) => {
	const fn = val => ({ _type, val, size: function(s) { this._size = s; return this; } });
	fn.toJSON = () => ({ _type });
	fn._type = _type;
	return fn;
};

export const [ bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas ] =
	[ 'bool', 'bits', 'float', 'varint', 'string', 'blob', 'objectid', 'uuid', 'date', 'lonlat', 'array', 'schemas' ].map(genType);
