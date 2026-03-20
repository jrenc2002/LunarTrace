const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// 简单的日志工具
const logger = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};

// 延时函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 动态加载 serialport 模块
let SerialPort = null;

function formatFatalError(error) {
    if (!error) return 'Unknown error';
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

function exitWithFatalError(error) {
    logger.error(`[ERROR] ${formatFatalError(error)}`);
    process.exit(1);
}

process.on('uncaughtException', (error) => {
    exitWithFatalError(error);
});

process.on('unhandledRejection', (reason) => {
    exitWithFatalError(reason);
});

function loadSerialPort() {
    if (SerialPort) return SerialPort;
    
    // 尝试多个可能的路径加载 serialport
    const possiblePaths = [
        // 从 electron 目录加载
        path.join(__dirname, '..', '..', 'electron', 'node_modules', 'serialport'),
        // 从 app.asar.unpacked 加载 (打包后)
        path.join(__dirname, '..', '..', 'electron', 'node_modules', 'serialport'),
        // 直接 require (如果在 NODE_PATH 中)
        'serialport'
    ];
    
    for (const modulePath of possiblePaths) {
        try {
            const serialportModule = require(modulePath);
            SerialPort = serialportModule.SerialPort;
            logger.log('成功加载 serialport 模块:', modulePath);
            return SerialPort;
        } catch (e) {
            // 继续尝试下一个路径
        }
    }
    
    throw new Error('无法加载 serialport 模块，请确保已安装依赖');
}

// 获取串口列表
async function getPortsList() {
    try {
        const SP = loadSerialPort();
        const ports = await SP.list();
        return ports;
    } catch (error) {
        logger.error('获取串口列表失败:', error);
        return [];
    }
}

// 1200bps touch 操作：以1200波特率连接串口并断开，触发板子重置
async function perform1200bpsTouch(portPath) {
    logger.log('执行 1200bps touch, 串口:', portPath);
    const SP = loadSerialPort();
    
    return new Promise((resolve, reject) => {
        const port = new SP({
            path: portPath,
            baudRate: 1200,
            autoOpen: false
        });

        port.open((err) => {
            if (err) {
                logger.error('1200bps touch 串口打开失败:', err.message);
                reject(err);
                return;
            }

            // 等待250ms后关闭
            setTimeout(() => {
                port.close((closeErr) => {
                    if (closeErr) {
                        logger.warn('1200bps touch 串口关闭警告:', closeErr.message);
                    }
                    // 再等待250ms让板子完成重置
                    setTimeout(() => {
                        logger.log('1200bps touch 完成');
                        resolve();
                    }, 250);
                });
            }, 250);
        });
    });
}

// 轮询等待新串口出现
// portsBefore: 操作前的串口列表
// timeout: 超时时间（毫秒），默认 10000
// interval: 轮询间隔（毫秒），默认 200
// 返回新端口路径，超时返回 null
async function waitForNewPort(portsBefore, timeout = 10000, interval = 200) {
    const startTime = Date.now();
    logger.log(`开始轮询等待新串口（超时 ${timeout}ms，间隔 ${interval}ms）...`);
    while (Date.now() - startTime < timeout) {
        const portsNow = await getPortsList();
        const newPorts = portsNow.filter(
            p => !portsBefore.some(ep => ep.path === p.path)
        );
        if (newPorts.length > 0) {
            logger.log(`轮询 ${Date.now() - startTime}ms 后检测到新端口:`, newPorts[0].path);
            return newPorts[0].path;
        }
        await delay(interval);
    }
    logger.log(`轮询超时（${timeout}ms），未检测到新端口`);
    return null;
}

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        logger.error('Usage: node upload.js <config-path>');
        process.exit(1);
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        logger.error('Failed to read config file:', error);
        process.exit(1);
    }

    const {
        currentProjectPath,
        buildPath,
        boardModule,
        appDataPath,
        serialPort: initialSerialPort,
        uploadParam: configUploadParam,
        use_1200bps_touch,
        wait_for_upload
    } = config;

    // console.log('上传配置:', {
    //     currentProjectPath,
    //     buildPath,
    //     boardModule,
    //     appDataPath,
    //     serialPort: initialSerialPort,
    //     uploadParam: configUploadParam
    // });

    try {
        // 1. 路径准备
        const tempPath = path.join(currentProjectPath, '.temp');
        // const buildPath = path.join(tempPath, 'build');
        const compilerPath = path.join(appDataPath, 'compiler');
        const sdkPath = path.join(appDataPath, 'sdk');
        const toolsPath = path.join(appDataPath, 'tools');

        // 2. 读取项目信息
        const projectPackageJsonPath = path.join(currentProjectPath, 'package.json');
        if (!fs.existsSync(projectPackageJsonPath)) {
            throw new Error(`未找到项目包文件: ${projectPackageJsonPath}`);
        }
        const projectPackageJson = JSON.parse(fs.readFileSync(projectPackageJsonPath, 'utf8'));
        const projectConfig = projectPackageJson.projectConfig || {};

        // 3. 读取板子信息
        const boardModulePath = path.join(currentProjectPath, 'node_modules', boardModule);
        const boardJsonPath = path.join(boardModulePath, 'board.json');
        const boardPackageJsonPath = path.join(boardModulePath, 'package.json');

        if (!fs.existsSync(boardJsonPath)) {
            throw new Error(`未找到板子配置文件: ${boardJsonPath}`);
        }
        const boardJson = JSON.parse(fs.readFileSync(boardJsonPath, 'utf8'));

        if (!fs.existsSync(boardPackageJsonPath)) {
            throw new Error(`未找到板子包文件: ${boardPackageJsonPath}`);
        }
        const boardPackageJson = JSON.parse(fs.readFileSync(boardPackageJsonPath, 'utf8'));
        const boardDependencies = boardPackageJson.boardDependencies || {};

        // 4. 获取上传参数（优先使用配置中已清理的参数）
        let uploadParam = configUploadParam || boardJson.uploadParam;
        if (!uploadParam) {
            throw new Error('未找到上传参数(uploadParam)');
        }

        // 去掉末尾的分号
        uploadParam = uploadParam.trim().replace(/;+$/, '');

        logger.log('使用的上传参数:', uploadParam);

        // core
        const coreItem = boardJson?.core || 'arduino';
        const core = coreItem.split(":")[0];

        // 5. 根据核心选择不同的上传参数处理方式
        let defaultBaudRate;
        if (core === 'arduino') {
            defaultBaudRate = '115200';
        } else {
            defaultBaudRate = '921600';
        }

        console.log('使用的核心:', core);
        console.log('默认波特率:', defaultBaudRate);

        // 6. 获取波特率
        const baudRate = projectConfig?.UploadSpeed || defaultBaudRate;
        console.log('使用的波特率:', baudRate);

        // 7. 获取工具依赖
        const toolDependencies = {};
        Object.entries(boardDependencies || {})
            .filter(([key, value]) => key.startsWith('tool-') || key.startsWith('@aily-project/tool-'))
            .forEach(([key, value]) => {
                let name = key;
                const prefixAily = '@aily-project/tool-';
                const prefixTool = 'tool-';
                if (name.startsWith(prefixAily)) {
                    name = name.slice(prefixAily.length);
                } else if (name.startsWith(prefixTool)) {
                    name = name.slice(prefixTool.length);
                }
                toolDependencies[name] = value;
            });

        // 8. 获取SDK路径
        let fullSdkPath = '';
        Object.entries(boardDependencies || {}).forEach(([key, version]) => {
            if (key.startsWith('@aily-project/sdk-')) {
                const sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
                fullSdkPath = path.join(sdkPath, sdk);
            }
        });

        // 9. 预构建上传命令（串口用占位符，后续替换）
        const platform = os.platform() === 'win32' ? 'win32' : (os.platform() === 'darwin' ? 'darwin' : 'linux');
        const SERIAL_PLACEHOLDER = '__SERIAL_PORT_PLACEHOLDER__';
        
        const { command, args: templateArgs } = await processUploadParams(
            uploadParam,
            buildPath,
            toolsPath,
            fullSdkPath,
            baudRate,
            toolDependencies,
            SERIAL_PLACEHOLDER,
            platform
        );

        // 10. 上传预处理：处理 1200bps touch 和 wait_for_upload
        // 四种组合：
        //   touch=false, wait=false → 直接使用原端口
        //   touch=true,  wait=false → 执行 1200bps touch，短暂延时后检测一次新端口
        //   touch=false, wait=true  → 不做 touch，轮询等待新端口出现（外部触发）
        //   touch=true,  wait=true  → 执行 1200bps touch，然后轮询等待新端口出现
        let finalSerialPort = initialSerialPort;

        // 如果需要检测新端口，先记录当前端口列表作为基准
        const needDetectNewPort = use_1200bps_touch || wait_for_upload;
        const portsBefore = needDetectNewPort ? await getPortsList() : [];
        if (needDetectNewPort) {
            logger.log('操作前串口列表:', portsBefore.map(p => p.path));
        }

        // Step 1: 执行 1200bps touch（如果配置了）
        if (use_1200bps_touch) {
            try {
                await perform1200bpsTouch(finalSerialPort);
            } catch (err) {
                logger.warn('1200bps touch 警告（将继续尝试上传）:', err.message);
            }
        }

        // Step 2: 等待新端口
        if (wait_for_upload) {
            const newPort = await waitForNewPort(portsBefore, 10000, 200);
            if (newPort) {
                finalSerialPort = newPort;
            } else {
                logger.log('未检测到新端口，继续使用原端口:', finalSerialPort);
            }
        } else if (use_1200bps_touch) {
            await delay(200);
            const portsAfter = await getPortsList();
            const newBootloaderPorts = portsAfter.filter(
                p => !portsBefore.some(ep => ep.path === p.path)
            );
            if (newBootloaderPorts.length > 0) {
                finalSerialPort = newBootloaderPorts[0].path;
                logger.log('1200bps touch 后检测到新 bootloader 端口:', finalSerialPort);
            } else {
                logger.log('1200bps touch 后未检测到新端口，继续使用原端口:', finalSerialPort);
            }
        }

        // 11. 将占位符替换为最终串口，生成最终参数
        logger.log('使用串口:', finalSerialPort);
        const args = templateArgs.map(a => a.replace(SERIAL_PLACEHOLDER, finalSerialPort));
        const shellCommand = wrapInQuotesIfNeeded(command);

        logger.log(`Executing: ${shellCommand} ${args.join(' ')}`);

        // 12. 执行上传命令
        const child = spawn(shellCommand, args, {
            cwd: buildPath,
            shell: true,
            stdio: 'inherit'
        });

        child.on('close', (code) => {
            if (code !== 0) {
                process.exit(code);
            } else {
                process.exit(0);
            }
        });

    } catch (error) {
        logger.error(`[ERROR] ${error.message}`);
        process.exit(1);
    }
}

async function processUploadParams(uploadParam, buildPath, toolsPath, sdkPath, baudRate, toolDependencies, serialPort, platform) {
    // 1. 基础变量替换
    let paramString = uploadParam;
    
    // 替换 ${baud}
    if (paramString.includes('${baud}')) {
        paramString = paramString.replace(/\$\{baud\}/g, baudRate);
    }

    // 替换 ${serial}
    if (paramString.includes('${serial}')) {
        paramString = paramString.replace(/\$\{serial\}/g, serialPort);
    }

    // 替换 ${boot_app0}
    if (paramString.includes('${boot_app0}')) {
        paramString = paramString.replace(/\$\{boot_app0\}/g, `"${path.join(sdkPath, 'tools', 'partitions', 'boot_app0.bin')}"`);
    }

    // 替换 ${bootloader}
    if (paramString.includes('${bootloader}')) {
        const bootLoaderFile = await findFile(buildPath, '*.bootloader.bin');
        paramString = paramString.replace(/\$\{bootloader\}/g, `"${bootLoaderFile}"`);
    }

    // 替换 ${partitions}
    if (paramString.includes('${partitions}')) {
        const partitionsFile = await findFile(buildPath, '*.partitions.bin');
        paramString = paramString.replace(/\$\{partitions\}/g, `"${partitionsFile}"`);
    }

    // 分割参数
    let paramList = parseArgs(paramString);

    // 2. 查找工具可执行文件
    const toolName = paramList[0];
    let toolVersion = toolDependencies[toolName];
    
    if (!toolVersion) {
        // 模糊匹配
        const matchedTool = Object.keys(toolDependencies).find(key => {
            return key.toLowerCase().includes(toolName.toLowerCase());
        });
        if (matchedTool) {
            toolVersion = toolDependencies[matchedTool];
        }
    }

    const isWindows = platform === 'win32';
    const toolFileName = toolName + (isWindows ? '.exe' : '');
    
    let commandPath = await findFile(toolsPath, toolFileName, toolVersion);
    // console.log("Command Path: ", commandPath);
    
    if (!commandPath) {
        throw new Error(`无法找到可执行文件: ${toolFileName}`);
    }

    // 3. 处理 ${'filename'} 格式的文件路径参数
    for (let i = 1; i < paramList.length; i++) {
        const param = paramList[i];
        const match = param.match(/\$\{\'(.+?)\'\}/);
        
        if (match) {
            const fileName = match[1];
            const ext = path.extname(fileName).toLowerCase().replace('.', '');
            
            let findRes = '';
            
            if (!['bin', 'elf', 'hex', 'eep', 'img', 'uf2'].includes(ext)) {
                findRes = await findFile(toolsPath, fileName);
                if (!findRes) {
                    findRes = await findFile(path.join(sdkPath, 'tools'), fileName);
                }
            } else {
                // console.log('Searching build path for file:', buildPath, fileName);
                findRes = await findFile(buildPath, fileName);
            }

            if (findRes) {
                const paramHasQuotes = param.startsWith('"') || param.includes('"');
                const replacement = paramHasQuotes ? findRes : `"${findRes}"`;
                paramList[i] = param.replace(`\$\{\'${fileName}\'\}`, replacement);
            } else {
                logger.warn(`无法找到文件: ${fileName}`);
            }
        }
    }

    return {
        command: commandPath,
        args: paramList.slice(1)
    };
}

// 简单的参数解析，处理引号
function parseArgs(str) {
    const args = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '"') {
            inQuote = !inQuote;
            current += char;
        } else if (char === ' ' && !inQuote) {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current) args.push(current);
    return args;
}

function wrapInQuotesIfNeeded(value) {
    if (!value || value.startsWith('"') || !/\s/.test(value)) {
        return value;
    }

    return `"${value}"`;
}

// 递归查找文件
async function findFile(basePath, pattern, version = '') {
    if (!fs.existsSync(basePath)) return '';

    const files = await findFilesRecursive(basePath);
    
    let matchedFiles = [];
    
    if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        matchedFiles = files.filter(f => regex.test(path.basename(f)));
    } else {
        matchedFiles = files.filter(f => path.basename(f) === pattern);
    }

    if (matchedFiles.length === 0) return '';

    if (version && matchedFiles.length > 1) {
        const versionMatched = matchedFiles.find(f => f.includes(version));
        if (versionMatched) return versionMatched;
    }

    // 优先返回路径最短的，或者按某种规则排序
    return matchedFiles[0];
}

async function findFilesRecursive(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(await findFilesRecursive(filePath));
        } else {
            results.push(filePath);
        }
    }
    return results;
}

main().catch(e => {
    logger.error(e);
    process.exit(1);
});
