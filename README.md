```javascript
import p from './pack.mjs';
const { Pack, bool, bits, int, float, varint, string, blob, array, selectOne, selectMany } = p;

type = bool // true or false
type = bits(x) // x = number of bits 1-32 for unsigned integer, max int = 2**x - 1
type = int(x) // x = 8, 16, or 32 bits for signed integer
type = float(x) // x = 16, 32, or 64 bits for floating point number
type = varint // variable length integer, max int = 1_073_741_823
type = string // any string
type = string([ 'str1', 'str2' ]) // one of specific strings, encoded as integer
type = blob // any length buffer
type = blob(x) // specific byte size buffer 
type = array(type) // array of any type
type = array(type, size) // specific length array
type = { field1: type, field2: type, .. } // object with all fields
type = selectOne({ field1: type, field2: type, .. }) // object with a single field active
type = selectMany({ field1: type, field2: type, .. }) // object with multiple optional fields
type = null // takes up no space

schema = type

const { encode, decode } = Pack(schema)
const { encode, decode } = Pack(JSON.stringify(schema))

buf = encode(data) 

data = decode(buf) 
```
