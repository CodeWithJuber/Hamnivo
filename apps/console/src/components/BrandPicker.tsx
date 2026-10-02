import { type BrandRef, useBrandRefs } from '../lib/names';
import { SelectField } from './Fields';

/** The brand a per-brand page shows: the one in the link, otherwise the first active brand. */
export function useChosenBrand(requested: string | undefined) {
  const brands = useBrandRefs();
  const active = (brands.items ?? []).filter((brand) => brand.status === 'active');
  const chosen = active.find((brand) => brand.id === requested) ?? active[0];
  return { brands, active, chosen };
}

/** Switches between brands; hidden when there is only one. */
export function BrandPicker({
  id,
  label,
  brands,
  value,
  onChange,
}: {
  id: string;
  label: string;
  brands: BrandRef[];
  value: string;
  onChange: (brandId: string) => void;
}) {
  if (brands.length <= 1) return null;
  return (
    <div className="max-w-sm">
      <SelectField
        id={id}
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        options={brands.map((brand) => ({ value: brand.id, label: brand.name }))}
      />
    </div>
  );
}
