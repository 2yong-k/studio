import { type Command, parse, usageError } from './shared.ts';

const USAGE = 'price <endpoint>...';

// Spends nothing, but it is a network call, so it goes through the provider like every other. The answer is passed on
// as the provider states it: picking or merging quotes is the estimate's job, where a wrong guess could price low.
export const price: Command = async (args, app) => {
  const { positionals } = parse(args, {}, USAGE);
  if (positionals.length === 0) throw usageError(USAGE, 'name at least one endpoint');
  const provider = await app.provider();
  return { quotes: await provider.price(positionals) };
};
