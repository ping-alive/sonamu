import { FormDropdownProps, Button, FormDropdown } from "semantic-ui-react";
import { SonamuUIService } from "../services/sonamu-ui.service";
import { defaultCatch } from "../services/sonamu.shared";
import { SyntheticEvent } from "react";
import { camelize } from "inflection";

export function FormTypeIdAsyncSelect({
  filter,
  withAddEnumButton,
  ...props
}: FormDropdownProps & {
  filter?: "enums" | "types";
  withAddEnumButton?: {
    entityId: string;
    propName: string;
  };
}) {
  const { data, isLoading, mutate } = SonamuUIService.useTypeIds(filter);
  const { typeIds } = data ?? {};

  const promptAddEnum = () => {
    if (!withAddEnumButton) {
      return;
    }

    const defEnumId = `${withAddEnumButton.entityId}${camelize(
      withAddEnumButton.propName
    )}`;
    const newEnumId = prompt("New Enum ID", defEnumId);
    if (!newEnumId) {
      return;
    }

    const { entityId } = withAddEnumButton;
    SonamuUIService.createEnumId({
      entityId,
      newEnumId,
    })
      .then(() => {
        mutate();
        setTimeout(() => {
          if (props.onChange) {
            props.onChange({} as SyntheticEvent<HTMLElement, Event>, {
              value: newEnumId,
            });
          }
        }, 100);
      })
      .catch(defaultCatch);
  };

  return (
    <>
      <FormDropdown
        placeholder="TypeId"
        selection
        options={(typeIds ?? []).map((typeId) => ({
          key: typeId,
          value: typeId,
          text: typeId,
        }))}
        disabled={!typeIds}
        loading={isLoading}
        selectOnBlur={false}
        {...props}
      />
      <Button icon="refresh" size="mini" onClick={() => mutate()} />
      {withAddEnumButton && (
        <Button icon="plus" size="mini" onClick={() => promptAddEnum()} />
      )}
    </>
  );
}
