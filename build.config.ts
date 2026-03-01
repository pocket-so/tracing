import { defineBuildConfig } from 'obuild/config';

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: [
        'src/loggers/axiom/index.ts',
        'src/loggers/sentry/index.ts',
        'src/loggers/timescale/index.ts',
        'src/loggers/console/index.ts',
        'src/middleware/index.ts',
        'src/utils/helpers.ts',
        'src/db/index.ts',
      ],
      rolldown: {
        tsconfig: 'tsconfig.json',
        platform: 'browser',
      },
    },
  ],
});
