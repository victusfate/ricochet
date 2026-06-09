[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / parseTopicWeights

# Function: parseTopicWeights()

> **parseTopicWeights**(`value`): `object`

Defined in: [parsing.ts:60](https://github.com/victusfate/ricochet/blob/31ed1ed9d6ed446c934601082ec6497875386ea1/src/parsing.ts#L60)

Parses and validates a topic-weights map from an untrusted source.
Keys are topic names; values are non-negative multipliers capped at 10×.

## Parameters

### value

`unknown`

## Returns

`object`

### message?

> `optional` **message?**: `string`

### weights?

> `optional` **weights?**: `Record`\<`string`, `number`\>
