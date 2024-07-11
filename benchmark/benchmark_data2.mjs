import avsc from 'avsc';
import protobuf from 'protobufjs';
import msgpack from '@msgpack/msgpack';
import { bool, bits, PackBytes } from '../packbytes.mjs';

// encode data benchmark
const data = { field1: true, field2: false, field3: 3, field4: 7, field5: 15, field6: 31, field7: 63, field8: 1023 };

const proto = await protobuf.load('./protobuf_schemas/data2.proto');
const protoEncoder = proto.lookupType('userpackage.Data');
const avscEncoder = avsc.Type.forValue(data);
const { encode, decode } = new PackBytes({ field1: bool, field2: bool, field3: bits(2), field4: bits(3), field5: bits(4), field6: bits(5), field7: bits(6), field8: bits(10) });

const encodeFns = {
   json: data => Buffer.from(JSON.stringify(data)),
   packBytes: data => encode(data),
   avsc: data => avscEncoder.toBuffer(data),
   protobuf: data => protoEncoder.encode(data).finish(),
   msgpack: data => msgpack.encode(data),
};

const iterations = 30_000_000;

for (const type in encodeFns) {
   let i = iterations;
   const time = process.hrtime.bigint();
   while (i--) encodeFns[type](data);
   console.log(`${type} encode time(ns): ${Math.floor(Number(process.hrtime.bigint() - time) / iterations)} - bytes: ${encodeFns[type](data).length}`);
}
