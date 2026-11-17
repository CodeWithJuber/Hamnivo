import type { StaffPublicProfile } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '../../components/Fields';
import { api, isApiError } from '../../lib/api';
import { isHttpsUrl } from '../../lib/appearance';
import { useStudioMutation, useStudioQuery } from '../../lib/queries';

export const publicProfileKey = ['inbox', 'profile'] as const;

/** Initials for a name: up to two letters, the way the chat draws someone without a photo. */
export const initialsOf = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toLocaleUpperCase();

/**
 * What customers see of this person in the chat while they are online (W17): a first name and a
 * photo. Nothing else about them reaches the chat.
 */
export function PublicProfileSection() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const profile = useStudioQuery<StaffPublicProfile>(publicProfileKey, '/v1/inbox/profile');
  const save = useStudioMutation(
    (body: { publicName: string | null; photoUrl: string | null }, tenant) =>
      api<StaffPublicProfile>('/v1/inbox/profile', { method: 'PATCH', body, tenant }),
    [publicProfileKey],
  );
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState('');
  const [errors, setErrors] = useState<{ name?: string; photo?: string }>({});
  useEffect(() => {
    if (!profile.data) return;
    setName(profile.data.publicName ?? '');
    setPhoto(profile.data.photoUrl ?? '');
  }, [profile.data]);
  if (!profile.data) return null;
  const shown = name.trim() || profile.data.shownAs;
  const photoOk = photo.trim() !== '' && isHttpsUrl(photo);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (name.trim().length > 40) next.name = t('inboxAlerts.profile.nameTooLong');
    if (photo.trim() && !isHttpsUrl(photo)) next.photo = t('inboxAlerts.profile.photoHttps');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      const saved = await save.mutateAsync({
        publicName: name.trim() || null,
        photoUrl: photo.trim() || null,
      });
      announce(t('inboxAlerts.profile.saved', { name: saved.shownAs }));
    } catch (error) {
      if (!isApiError(error, 'VALIDATION_FAILED')) throw error;
      setErrors({ photo: t('inboxAlerts.profile.photoHttps') });
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      data-testid="public-profile"
      noValidate
    >
      <h3 className="text-sm font-semibold text-text">{t('inboxAlerts.profile.title')}</h3>
      <p className="text-sm text-text-secondary">{t('inboxAlerts.profile.hint')}</p>
      <div
        className="flex items-center gap-3"
        aria-hidden="true"
        data-testid="public-profile-preview"
      >
        {photoOk ? (
          <img
            src={photo.trim()}
            alt=""
            referrerPolicy="no-referrer"
            className="size-10 rounded-full object-cover"
          />
        ) : (
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {initialsOf(shown)}
          </span>
        )}
        <span className="text-sm font-medium text-text">
          <bdi>{shown}</bdi>
        </span>
      </div>
      <TextField
        id="public-name"
        label={t('inboxAlerts.profile.name')}
        hint={t('inboxAlerts.profile.nameHint', { name: profile.data.shownAs })}
        value={name}
        maxLength={40}
        error={errors.name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        id="public-photo"
        label={t('inboxAlerts.profile.photo')}
        hint={t('inboxAlerts.profile.photoHint')}
        inputMode="url"
        value={photo}
        error={errors.photo}
        onChange={(event) => setPhoto(event.target.value)}
      />
      <Button type="submit" className="self-start" busy={save.isPending}>
        {t('inboxAlerts.profile.save')}
      </Button>
    </form>
  );
}
