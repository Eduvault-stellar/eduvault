import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

export interface FlakyTestRecord {
  title: string;
  file: string;
  line: number;
  retries: number;
  totalAttempts: number;
  durationMs: number;
  errors: string[];
}

/**
 * Custom Playwright Reporter to explicitly track, surface, and summarize
 * flaky tests and retry attempts rather than letting retries silently hide instability.
 */
export default class FlakeReporter implements Reporter {
  private flakyTests: FlakyTestRecord[] = [];
  private retryAttempts = new Map<string, number>();

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.flakyTests = [];
    this.retryAttempts.clear();
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const testKey = `${test.location.file}:${test.location.line} - ${test.title}`;
    const currentAttempt = result.retry + 1;
    this.retryAttempts.set(testKey, currentAttempt);

    // If test failed on an initial run or retry, log retry attempt
    if (result.status !== 'passed' && result.retry < test.retries) {
      console.warn(
        `\x1b[33m[RETRY INITIATED]\x1b[0m "${test.title}" failed on attempt ${currentAttempt}/${test.retries + 1}. Retrying... (Status: ${result.status})`
      );
    }

    // Playwright defines a test outcome as 'flaky' when it failed initially but passed upon retry
    if (result.status === 'passed' && result.retry > 0) {
      const errorMessages = test.results
        .filter((r) => r.status !== 'passed' && r.error?.message)
        .map((r) => r.error?.message || 'Unknown error');

      this.flakyTests.push({
        title: test.title,
        file: test.location.file,
        line: test.location.line,
        retries: result.retry,
        totalAttempts: currentAttempt,
        durationMs: test.results.reduce((acc, r) => acc + r.duration, 0),
        errors: errorMessages,
      });

      console.warn(
        `\x1b[33m  [FLAKE RETRY DETECTED]\x1b[0m "${test.title}" passed on retry attempt ${result.retry}/${test.retries}.\n` +
          `   Location: ${test.location.file}:${test.location.line}\n` +
          `   Status: Flaky (Unstable in CI / needs investigation)\n`
      );
    }
  }

  onEnd(_result: FullResult): void {
    if (this.flakyTests.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log(
        `\x1b[33m  FLAKY TESTS REPORT (${this.flakyTests.length} flaky test${this.flakyTests.length === 1 ? '' : 's'} detected)\x1b[0m`
      );
      console.log('='.repeat(80));
      for (const [index, flake] of this.flakyTests.entries()) {
        console.log(
          `\x1b[33m${index + 1}. [FLAKE]\x1b[0m ${flake.title}\n` +
            `   File: ${flake.file}:${flake.line}\n` +
            `   Passed on retry #${flake.retries} (${flake.totalAttempts} total attempts, cumulative time: ${flake.durationMs}ms)`
        );
        if (flake.errors.length > 0) {
          console.log(`   Initial Failure Reason: ${flake.errors[0]?.split('\n')[0]}`);
        }
        console.log('');
      }
      console.log(
        `\x1b[33mNotice: Retries allowed the build to pass, but the above tests exhibited flakiness and must be resolved.\x1b[0m`
      );
      console.log('='.repeat(80) + '\n');
    }
  }
}
