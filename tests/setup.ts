import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library registers its own cleanup only when Vitest globals are
// enabled, and this suite imports its helpers explicitly instead. Without this,
// rendered trees accumulate across tests in a file and every query finds
// duplicates.
afterEach(cleanup);
