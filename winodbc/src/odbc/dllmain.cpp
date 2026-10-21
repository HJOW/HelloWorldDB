#include "hwdbodbc/odbc.hpp"

// 정적 CRT를 사용한다. 로더 잠금 아래에서 스레드/네트워크/UI를 초기화하지 않는다.
BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) {
    return TRUE;
}
