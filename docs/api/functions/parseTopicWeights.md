[**@victusfate/ricochet v1.4.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / parseTopicWeights

# Function: parseTopicWeights()

> **parseTopicWeights**(`value`): `object`

Defined in: parsing.ts:58

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
