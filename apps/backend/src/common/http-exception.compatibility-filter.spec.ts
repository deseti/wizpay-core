import { HttpException, HttpStatus } from '@nestjs/common';
import { mapHttpException } from './http-exception.compatibility-filter';

describe('mapHttpException', () => {
  it('preserves structured HTTP exceptions from a foreign Nest copy', () => {
    expect(
      mapHttpException({
        getStatus: () => HttpStatus.SERVICE_UNAVAILABLE,
        getResponse: () => ({
          code: 'CAPABILITY_DISABLED',
          message: 'This feature is unavailable on the selected Arc network.',
        }),
      }),
    ).toEqual({
      status: 503,
      body: {
        code: 'CAPABILITY_DISABLED',
        message: 'This feature is unavailable on the selected Arc network.',
      },
    });
  });

  it('preserves native Nest HTTP exceptions', () => {
    expect(
      mapHttpException(new HttpException({ code: 'CAPABILITY_DISABLED' }, 503)),
    ).toEqual({
      status: 503,
      body: { code: 'CAPABILITY_DISABLED' },
    });
  });
});
