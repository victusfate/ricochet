[**@victusfate/ricochet v1.7.1**](../README.md)

***

[@victusfate/ricochet](../globals.md) / parseTopicWeights

# Function: parseTopicWeights()

> **parseTopicWeights**(`value`): `object`

Defined in: [parsing.ts:58](https://github.com/victusfate/ricochet/blob/05e1024558aa1ca4731aa49eeb4d4c7706ca9bcb/src/parsing.ts#L58)

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
