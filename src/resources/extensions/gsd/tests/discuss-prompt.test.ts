import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

const promptPath = join(process.cwd(), 'src/resources/extensions/gsd/prompts/discuss.md');
const discussPrompt = readFileSync(promptPath, 'utf-8');

console.log('\n=== discuss prompt: resilient vision framing ===');
{
  const hardenedPattern = /Say exactly:\s*"What's the vision\?"/;
  assert(!hardenedPattern.test(discussPrompt), 'prompt no longer uses exact-verbosity lock');
  assert(
    discussPrompt.includes('Ask: "What\'s the vision?" once'),
    'prompt asks for vision exactly once',
  );
  assert(
    discussPrompt.includes('Special handling'),
    'prompt documents special handling for non-vision user messages',
  );
  assert(
    discussPrompt.includes('instead of repeating "What\'s the vision?"'),
    'prompt forbids repeating the vision question',
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed ✓');
