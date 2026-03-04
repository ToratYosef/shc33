import chalk from 'chalk';

export const palette = {
  green: chalk.hex('#00ff66'),
  dim: chalk.hex('#44aa66')
};

export function printBanner() {
  process.stdout.write(
    `${palette.green('\n[ AUTHORIZED TERMINAL ]')} ${palette.dim('ONE-TIME EPHEMERAL CHANNEL\n')}`
  );
}
