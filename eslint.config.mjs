// scaffold-linter: js sha256:1ca27450129b
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      // scaffold quality thresholds — mirror the four-dimension rubric
      'max-lines': ['warn', { max: 500 }],
      'max-params': ['warn', 4],
      'complexity': ['warn', 10],
      'no-magic-numbers': ['warn', { ignore: [0, 1], ignoreArrayIndexes: true }],
    },
  },
];
