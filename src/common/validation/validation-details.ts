import { ValidationError } from 'class-validator';

export interface FieldValidationDetail {
  field: string;
  message: string;
}

export function toValidationDetails(
  errors: ValidationError[],
  parentPath = '',
): FieldValidationDetail[] {
  return errors.flatMap((error) => {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    const ownErrors = Object.values(error.constraints ?? {}).map((message) => ({
      field,
      message,
    }));
    return [...ownErrors, ...toValidationDetails(error.children ?? [], field)];
  });
}
