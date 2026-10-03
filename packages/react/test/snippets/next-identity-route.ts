import { createIdentityAssertion } from '@hamnivo/server';

/** getUser stands for how your app reads the signed-in user from a request. */
declare function getUser(
  request: Request,
): Promise<{ id: string; name: string; email: string; emailVerified: boolean } | null>;

export async function GET(request: Request): Promise<Response> {
  const user = await getUser(request);
  if (!user) return new Response(null, { status: 401 });
  const assertion = await createIdentityAssertion({
    widgetId: process.env.HAMNIVO_WIDGET_ID!,
    key: {
      kid: process.env.HAMNIVO_IDENTITY_KID!,
      alg: 'HS256',
      secret: process.env.HAMNIVO_IDENTITY_SECRET!,
    },
    customer: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
    },
  });
  return Response.json({ assertion }, { headers: { 'cache-control': 'no-store' } });
}
