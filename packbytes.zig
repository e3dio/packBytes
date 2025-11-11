const Type = enum(u8) {
	.bool,

	.bits_1,
	.bits_2,
	.bits_3,
	.bits_4,
	.bits_5,
	.bits_6,
	.bits_7,
	.bits_8,
	.bits_9,
	.bits_10,
	.bits_11,
	.bits_12,
	.bits_13,
	.bits_14,
	.bits_15,
	.bits_16,
	.bits_17,
	.bits_18,
	.bits_19,
	.bits_20,
	.bits_21,
	.bits_22,
	.bits_23,
	.bits_24,
	.bits_25,
	.bits_26,
	.bits_27,
	.bits_28,
	.bits_29,
	.bits_30,
	.bits_31,
	.bits_32,

	.float_32,
	.float_64,

	.varint,

	.string,
	.string_size,

	.blob,
	.blob_size,

	.date,

	.array,
	.array_size,

	.object,

	.select,

	.union,

	.null,
};
