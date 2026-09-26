import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from '../components/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '../components/field';
import { FormErrorSummary } from '../components/form-error-summary';
import { Input } from '../components/input';
import { Label } from '../components/label';

/** HNV-24-02 Forms — disabled, read-only and invalid, with a linked error summary. */
const meta = { title: 'Interaction states/Forms (HNV-24-02)' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FieldStates: Story = {
  render: () => (
    <div className="grid max-w-md gap-6">
      <FormErrorSummary
        title="Fix 1 field to continue"
        focusOnMount={false}
        errors={[{ fieldId: 'email-invalid', message: 'Enter a valid email address' }]}
      />
      <Field>
        <FieldLabel htmlFor="email-default">Email</FieldLabel>
        <Input
          id="email-default"
          type="email"
          defaultValue="maya.saleh@example.com"
          autoComplete="email"
        />
      </Field>
      <Field data-invalid>
        <FieldLabel htmlFor="email-invalid">Email</FieldLabel>
        <Input
          id="email-invalid"
          type="email"
          defaultValue="maya.saleh@"
          aria-invalid
          aria-describedby="email-invalid-error"
        />
        <FieldError id="email-invalid-error">Enter a valid email address</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor="workspace-id">Workspace ID</FieldLabel>
        <Input
          id="workspace-id"
          defaultValue="ws_01J9Z4"
          readOnly
          aria-describedby="workspace-id-help"
        />
        <FieldDescription id="workspace-id-help">
          Read-only: workspace IDs cannot be changed.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="plan">Plan</FieldLabel>
        <Input id="plan" defaultValue="Team" disabled aria-describedby="plan-help" />
        <FieldDescription id="plan-help">
          Only the workspace owner can change the plan.
        </FieldDescription>
      </Field>
    </div>
  ),
};

export const Checkboxes: Story = {
  render: () => (
    <div className="flex gap-8">
      {(
        [
          ['unchecked', false, 'Unchecked'],
          ['checked', true, 'Checked'],
          ['mixed', 'indeterminate', 'Partially selected'],
        ] as const
      ).map(([id, checked, label]) => (
        <div key={id} className="flex items-center gap-2">
          <Checkbox id={`cb-${id}`} defaultChecked={checked} />
          <Label htmlFor={`cb-${id}`}>{label}</Label>
        </div>
      ))}
    </div>
  ),
};
