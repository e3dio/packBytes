import { bool, bits, string, array, float, blob, schemas, PackBytes } from '../packbytes.mjs';

export const logs = [];
const log = (...msg) => { console.log(...msg); logs.push(msg); };

let schema, data;

const test = (schema, ...data) => {
	log('DATA', JSON.stringify(data[1] ? data: data[0]));
	const encoder = new PackBytes(schema);
	const buf = encoder.encode(...data);
	log('BUF', PackBytes.isNode ? buf : [...new Uint8Array(buf.buffer)].map(x => x.toString(16).padStart(2, '0')).join(''));
	const obj = encoder.decode(buf);
	log('OBJ', JSON.stringify(obj));
	log('');
};

schema = schemas({
	test1: string,
	test2: {
		a: bool,
		b: bits(2)
	},
	test3: array(bits(3)),
	test4: null
});
test(JSON.stringify(schema), 'test1', '123');
test(JSON.stringify(schema), 'test2', {a:true,b:3});
test(JSON.stringify(schema), 'test3', [0,1,2,3,4,5,6,7]);
test(JSON.stringify(schema), 'test4');

schema = array(string('abc', '123', 'xyz'));
data = [ 'xyz', 'abc', '123' ];
test(JSON.stringify(schema), data);

schema = array(schemas({
	test1: string('abc', '123', 'xyz'),
	test2: array(bits(2)).size(4)
}))
data = [ [ 'test2', [ 3, 2, 1, 0] ], [ 'test1', 'xyz' ] ];
test(JSON.stringify(schema), data);

schema = {
	a: array(string('a','b')).size(3)
};
data = {a:['b','a','b']};
test(JSON.stringify(schema), data);

schema = array({
	a: bool,
	b: {
		1: bool,
		2: bits(2),
		3: array(bits(3)),
	},
	c: array({
		1: bool
	}),
});
data = [
	{
		a: false,
		b: {
			1: false,
			2: 0,
			3: [0,0],
		},
		c: [{
			1: false
		}]
	}, {
		a: true,
		b: {
			1: true,
			2: 3,
			3: [7,7],
		},
		c: [{
			1: true
		}]
	}
];
test(JSON.stringify(schema), data);

schema = {
	a: bool,
	b: bits(1),
	c: bits(2),
	d: bits(3),
	e: bits(4),
	f: bits(5),
	g: bits(6),
	h: bits(7),
	i: bits(8),
	1: bits(9),
	2: bits(10),
	3: bits(11),
	4: bits(12),
	5: bits(13),
	6: bits(14),
	7: string,
	8: array(bits(8)),
	9: float(32),
	10: float(64),
	11: blob,
	12: blob(3),
	13: {a:bool,b:bits(2),c:{d:bits(4),e:bits(5)}},
};
data = {
	a: 0,
	b: 1,
	c: 3,
	d: 7,
	e: 15,
	f: 31,
	g: 63,
	h: 127,
	i: 255,
	1: 511,
	2: 1023,
	3: 2047,
	4: 4095,
	5: 8191,
	6: 16383,
	7: 'abc123',
	8: [0,1,2,3,4,5,19,20,255],
	9: 1.2,
	10: 3221.1324,
	11: PackBytes.isNode ? Buffer.from([1,2,3]) : new Uint8Array([1,2,3]),
	12: PackBytes.isNode ? Buffer.from([4,5,6]) : new Uint8Array([4,5,6]),
	13: {a:true,b:3,c:{d:15,e:31}},
};
test(JSON.stringify(schema), data);
