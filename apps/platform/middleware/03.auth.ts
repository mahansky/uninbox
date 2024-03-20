import { defineEventHandler } from 'h3';
import type { UserContext } from '@u22n/types';
import type { DatabaseSession } from 'lucia';
import { getCookie, useStorage } from '#imports';

export default defineEventHandler(async (event) => {
  const sessionCookie = getCookie(event, 'unsession');
  if (!sessionCookie) {
    event.context.user = null;
    return;
  }
  const sessionStorage = useStorage('sessions');
  const sessionObject: DatabaseSession | null =
    await sessionStorage.getItem(sessionCookie);
  if (!sessionObject) {
    event.context.user = null;
    return;
  }
  const userContext: UserContext = {
    id: sessionObject.attributes.user.id,
    session: sessionObject
  };
  event.context.user = userContext;
});
