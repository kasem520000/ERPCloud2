import { redirect } from 'next/navigation';

/** The portal surface has no public landing — send everyone to the account dashboard. */
export default function CustomerPortalHome() {
  redirect('/portal');
}
