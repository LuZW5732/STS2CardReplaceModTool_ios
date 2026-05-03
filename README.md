# 杀戮尖塔2卡面替换mod制作工具iOS版

Slay The Spire 2 Card Replace Mod Tool for iOS



#### 为什么开发iOS版？

因为iOS系统不支持dll文件的运行，导致市面上绝大多数塔2mod都无法运行。经过验证，目前只有卡面、皮肤mod允许通过外置的方式安装运行（在无dll情况下），为此开发了iOS可用的卡面替换工具。



#### iOS如何安装mod？

目前只有两种办法，一种是通过自签名软件打开.app目录，将mods文件夹置于其内再安装。

另一种方法是使用LiveContainer，令我的STS2mod.dylib插件注入到游戏中，使其能够在外置的Documents目录下读取mods文件夹及其内容。


这是个纯ai项目，主要是因为懒。

## 开源协议
本项目采用 [MIT License](LICENSE) 开源协议。
