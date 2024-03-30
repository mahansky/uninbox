import {
  TRPCError,
  initTRPC,
  experimental_standaloneMiddleware as standaloneMiddleware
} from '@trpc/server';
import superjson from 'superjson';
import type { Context } from './createContext';
import { z } from 'zod';
import { useRuntimeConfig } from '#imports';
import verifyTurnstileToken from '../utils/turnstile';
import { type Duration, Ratelimit, NoopRatelimit } from '@unkey/ratelimit';
import { getRequestIP } from 'h3';

export const trpcContext = initTRPC
  .context<Context>()
  .create({ transformer: superjson });

const isAccountAuthenticated = trpcContext.middleware(({ next, ctx }) => {
  if (
    !ctx.account ||
    !ctx.account.session.attributes.account.id ||
    !ctx.account.id
  ) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You are not logged in, redirecting...'
    });
  }
  return next({
    ctx: { ...ctx, account: ctx.account }
  });
});

// It is not unstable - only the API might change in the future: https://trpc.io/docs/faq#unstable
const hasOrgSlug = isAccountAuthenticated.unstable_pipe(({ next, ctx }) => {
  if (!ctx.org) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid organization selected, redirecting...'
    });
  }

  const accountId = ctx.account?.id;
  const orgMembership = ctx.org?.members.find(
    (member) => member.accountId === accountId
  );

  if (!accountId || !orgMembership) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You are not a member of this organization, redirecting...'
    });
  }

  return next({
    ctx: {
      ...ctx,
      org: {
        ...ctx.org,
        memberId: orgMembership.id
      }
    }
  });
});

const isEeEnabled = trpcContext.middleware(({ next }) => {
  if (!useRuntimeConfig().billing?.enabled) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Enterprise Edition features are disabled on this server'
    });
  }
  return next();
});

//TODO: check when standalone middleware is no longer experimental or fix inputs in standard middleware
const turnstileTokenValidation = standaloneMiddleware<{
  input: { turnstileToken?: string }; // defaults to 'unknown' if not defined
}>().create(async (opts) => {
  if (!useRuntimeConfig().turnstile.secretKey) return opts.next();
  if (!opts.input.turnstileToken) {
    if (process.env.NODE_ENV === 'development') return opts.next();
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Missing Turnstile Verification Token'
    });
  }

  const success = await verifyTurnstileToken({
    response: opts.input.turnstileToken,
    secretKey: useRuntimeConfig().turnstile.secretKey
  });

  if (!success)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid Turnstile Verification Token'
    });

  return opts.next();
});

// Placeholder for the actual rate limits, to be defined later
const publicRateLimits = {
  checkUsernameAvailability: [100, '1m'],
  checkPasswordStrength: [100, '1m'],
  signUpPasskeyStart: [100, '1m'],
  signUpPasskeyFinish: [100, '1m'],
  generatePasskeyChallenge: [100, '1m'],
  verifyPasskey: [100, '1m'],
  signUpWithPassword: [100, '1m'],
  signInWithPassword: [100, '1m'],
  validateInvite: [100, '1m']
} satisfies Record<string, [number, Duration]>;

function createRatelimiter({
  limit,
  duration,
  namespace
}: {
  limit: number;
  duration: Duration;
  namespace: string;
}) {
  const rootKey = useRuntimeConfig().unkey.rootKey;
  const unkey = rootKey
    ? new Ratelimit({
        async: true,
        limit,
        duration,
        namespace,
        rootKey
      })
    : new NoopRatelimit();

  return trpcContext.middleware(async ({ ctx, next }) => {
    const ip = getRequestIP(ctx.event);
    const result = await unkey.limit(ip || 'unknown');
    if (!result.success) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests, please try again later'
      });
    }
    return next();
  });
}

export const publicProcedure = trpcContext.procedure;

export const publicRateLimitedProcedure = Object.entries(
  publicRateLimits
).reduce(
  (acc, [key, [limit, duration]]) => {
    // @ts-expect-error, we know this is a valid key
    acc[key] = trpcContext.procedure
      .input(z.object({ turnstileToken: z.string() }))
      .use(turnstileTokenValidation)
      .use(createRatelimiter({ limit, duration, namespace: `public.${key}` }));
    return acc;
  },
  {} as Record<keyof typeof publicRateLimits, typeof publicProcedure>
);

export const accountProcedure = trpcContext.procedure.use(
  isAccountAuthenticated
);
export const orgProcedure = trpcContext.procedure.use(hasOrgSlug);
export const eeProcedure = orgProcedure.use(isEeEnabled);

export const router = trpcContext.router;
export const middleware = trpcContext.middleware;
