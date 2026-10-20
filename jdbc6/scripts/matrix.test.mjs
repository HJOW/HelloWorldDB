import { registerTests } from "./test.mjs";

// 릴리스 전에는 Java 6·7·8 런타임의 누락을 건너뛰지 않고 실패시킨다.
registerTests(true);
