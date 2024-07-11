import avsc from 'avsc';
import protobuf from 'protobufjs';
import msgpack from '@msgpack/msgpack';
import { bool, bits, PackBytes } from '../packbytes.mjs';

// encode data benchmark
const data = { field1: true, field2: false, field3: 3, field4: 15 };

const proto = await protobuf.load('./protobuf_schemas/data1.proto');
const protoEncoder = proto.lookupType('userpackage.Data');
const avscEncoder = avsc.Type.forValue(data);
const { encode, decode } = PackBytes({ field1: bool, field2: bool, field3: bits(2), field4: bits(4) });

const encodeFns = {
   json: data => Buffer.from(JSON.stringify(data)),
   packBytes: data => encode(data),
   avsc: data => avscEncoder.toBuffer(data),
   protobuf: data => protoEncoder.encode(data).finish(),
   msgpack: data => msgpack.encode(data),
};

const iterations = 10_000_000;

for (const type in encodeFns) {
   let i = iterations;
   const time = process.hrtime.bigint();
   while (i--) encodeFns[type](data);
   console.log(`${type} encode time(ns): ${Math.floor(Number(process.hrtime.bigint() - time) / iterations)} - bytes: ${encodeFns[type](data).length}`);
}
