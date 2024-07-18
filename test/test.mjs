import { bool, bits, string, array, float, blob, schemas, PackBytes } from '../packbytes.mjs';
export const logs = [];
const log = (...msg) => console.log(...msg) || logs.push(msg);

const tests = [
	{ schema: bool, data: true },
	{ schema: bool, data: false },
	{ schema: bits(1), data: 0 },
	{ schema: bits(1), data: 1 },
	{ schema: bits(8), data: 255 },
	{ schema: bits(32), data: 4294967295 },
	{ schema: string, data: 'str' },
	{ schema: string([ 'str1', 'str2' ]), data: 'str2' },
	//{ schema: float(32), data: 1.33 },
	//{ schema: float(64), data: 12345678.901234 },
	{ schema: blob, data: new Uint8Array([ 0, 1 ]) },
	{ schema: blob(3), data: new Uint8Array([ 0, 1, 2 ]) },
	{ schema: array(bits(2)), data: [ 0, 1, 2, 3 ] },
	{ schema: schemas({ s1: null, s2: bits(3) }), data: [ 's2', 3 ] },
];
tests.push({
	schema: tests.reduce((obj, t, i) => (obj[i] = t.schema, obj), {}),
	data: tests.reduce((obj, t, i) => (obj[i] = t.data, obj), {})
});
tests.push(
	...tests.map(t => ({ schema: array(t.schema), data: [ t.data, t.data ] })),
	...tests.map(t => ({ schema: array(t.schema).size(3), data: [ t.data, t.data, t.data ] }))
);
tests.push({
	schema: tests.reduce((obj, t, i) => (obj[i] = t.schema, obj), {}),
	data: tests.reduce((obj, t, i) => (obj[i] = t.data, obj), {})
});
tests.push({
	schema: schemas({ s1: bool, s2: tests.slice(-1)[0].schema }),
	data: [ 's2', tests.slice(-1)[0].data ]
});

// run tests
let fail;
tests.forEach((t, i) => {
	if (fail) return;
	const json = JSON.stringify(t.schema);
	const { encode, decode } = PackBytes(json);
	log('');
	log('TEST', i + 1);
	log('schema:', json);
	log('data:', JSON.stringify(t.data));
	try {
		var buf = encode(t.data);
		log('buf:', buf);
		var result = decode(buf);
	} catch (e) {
		log('');
		log('FAIL:');
		log(e.stack);
		fail = true;
		return;
	}
	if (JSON.stringify(result) == JSON.stringify(t.data)) return;
	log('');
	log('FAIL:');
	log('data:', JSON.stringify(t.data));
	log('result:', result);
	log('result:', JSON.stringify(result));
	log('');
	fail = true;
});
if (!fail) {
	log('');
	log('ALL TESTS PASSED');
	log('');
}
