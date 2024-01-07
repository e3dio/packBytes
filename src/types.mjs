// Generic type objects for declaring schemas, allows nesting, setting values, and json export

const genType = _type => {
	const fn = val => ({ _type, val, size });
	fn.toJSON = () => ({ _type });
	fn._type = _type;
	return fn;
};

const size = function (s) { this._size = s; return this; };

export const [ bool, bits, float, varint, string, blob, objectid, uuid, date, lonlat, array, schemas ] =
              [ 'bool', 'bits', 'float', 'varint', 'string', 'blob', 'objectid', 'uuid', 'date', 'lonlat', 'array', 'schemas' ].map(genType);
