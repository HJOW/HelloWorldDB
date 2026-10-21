#pragma once

#include <iostream>
#include <stdexcept>

// Release에서도 검사를 생략하지 않는다.
inline void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Function>
int run_checks(Function&& function) {
    try {
        function();
        std::cout << "PASS\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    } catch (...) {
        std::cerr << "FAIL: unknown exception\n";
        return 1;
    }
}
