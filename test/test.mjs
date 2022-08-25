import { bool, bits, string, array, float, blob, schemas, PackBytes } from '../packbytes.mjs';
export const logs = [];
const log = (...msg) => console.log(...msg) || logs.push(msg);
const isNode = PackBytes.isNode;

const tests = [
	{ schema: bool, data: true },
	{ schema: bool, data: false },
	{ schema: bits(1), data: 0 },
	{ schema: bits(1), data: 1 },
	{ schema: bits(8), data: 255 },
	{ schema: bits(32), data: 4294967295 },
	{ schema: string, data: 'str' },
	{ schema: string('str1', 'str2'), data: 'str2' },
	//{ schema: float(32), data: 1.33 },
	//{ schema: float(64), data: 12345678.901234 },
	{ schema: blob, data: isNode ? Buffer.from([ 0, 1 ]) : new Uint8Array([ 0, 1 ]) },
	{ schema: blob(3), data: isNode ? Buffer.from([ 0, 1, 2 ]) : new Uint8Array([ 0, 1, 2 ]) },
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
	const json = JSON.stringify(t.schema);
	[ new PackBytes(t.schema), new PackBytes(json) ].forEach((encoder, j, arr) => {
		if (fail) return;
		log('');
		log('TEST', i * arr.length + j + 1);
		log(json);
		log(JSON.stringify(t.data));
		try {
			var buf = encoder.encode(t.data);
			log(buf, buf.length || buf.byteLength);
			var result = encoder.decode(buf);
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
		log(JSON.stringify(t.data));
		log(JSON.stringify(result));
		log('');
		fail = true;
	});
});
if (!fail) {
	log('');
	log('ALL TESTS PASSED');
	log('');
}
