// Keep every bit of the fixture ID. Raw hex still has confusable pairs (4/a,
// 8/b, 3/e) in the real display-name comparison key, so encode each nibble as a
// distinct lowercase Latin letter. This is test naming, not registration policy.
export function fixtureAgentName(agentId: string): string {
  if (!/^agent_[0-9a-f]{16}$/.test(agentId)) throw new Error('Expected a complete fixture agent ID');
  return 'Fixture-' + agentId.slice(6).replace(/[0-9a-f]/g, digit => 'abcdefghijklmnop'[parseInt(digit, 16)]);
}
